// CR-PUBLISH-OIDC acceptance (INTENTS I25; policy ci-job-definitions; follows
// CR-IMAGE-ACR, INTENTS I21; Rule: policies/placement-defaults.yaml#credentials):
// .github/workflows/publish.yml builds the ranker image once per merge to
// main on the ranker's dedicated self-hosted runner (labels self-hosted, aks,
// corpus-ranker-ci) and pushes it to the estate Azure registry as
// noncelogicci.azurecr.io/corpus-ranker:sha-<commit>. The runner mounts no
// credentials: the Publish step mints a GitHub OIDC token (audience openbao),
// logs in to OPENBAO_ADDR at auth/jwt with role corpus-ranker-registry-push,
// reads kv/data/corpus-ranker/acr-push and logs docker in to the registry it
// names, password on stdin, never printing a token or the password. It no
// longer reads /etc/registry-push.
//
// Self-hosted runners hold estate access (docs/EXTERNAL-REVIEW.md §1), so the
// workflow must not be reachable from pull requests at all. ci.yml stays on
// GitHub-hosted runners and no longer publishes, so each merge yields exactly
// one publish.
//
// The workflow YAML is inspected with a narrow line scanner rather than a
// YAML library, to avoid a new dependency (docs/EXTERNAL-REVIEW.md §3). The
// Publish step's script is then run as written, against a stand-in `docker`
// and one local HTTP server standing in for both the GitHub OIDC token
// endpoint and OpenBao.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowsDir = resolve(repoRoot, ".github", "workflows");
const REGISTRY = "noncelogicci.azurecr.io";
const IMAGE = `${REGISTRY}/corpus-ranker`;
/** Labels the ranker's dedicated runner carries (meta-harness devops/aks/corpus-ranker-argo/README.md). */
const RUNNER_LABELS = ["self-hosted", "aks", "corpus-ranker-ci"];

/** Drop full-line and trailing comments so prose cannot satisfy a check. */
function stripComments(yaml: string): string {
  return yaml
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+#.*$/, ""))
    .join("\n");
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** The lines nested under the first `key:` found at the given indent. */
function block(yaml: string, key: string, indent: number): string[] {
  const lines = yaml.split("\n");
  const start = lines.findIndex(
    (line) => indentOf(line) === indent && line.trimStart().startsWith(`${key}:`),
  );
  if (start < 0) return [];
  const out = [lines[start]!];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() !== "" && indentOf(line) <= indent) break;
    out.push(line);
  }
  return out;
}

/** `name: value` pairs of a flat map block (its first line is the key). */
function mapEntries(lines: string[]): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const m = /^\s+([\w-]+):\s*(\S.*)?$/.exec(line);
    if (m) entries[m[1]!] = (m[2] ?? "").trim();
  }
  return entries;
}

/** Split `jobs:` into its job blocks, keyed by job id. */
function jobs(yaml: string): Map<string, string> {
  const lines = block(yaml, "jobs", 0).slice(1);
  const out = new Map<string, string>();
  let current: string | undefined;
  for (const line of lines) {
    const m = /^ {2}([\w-]+):\s*$/.exec(line);
    if (m) {
      current = m[1]!;
      out.set(current, "");
      continue;
    }
    if (current) out.set(current, `${out.get(current)}${line}\n`);
  }
  return out;
}

const publish = stripComments(readFileSync(resolve(workflowsDir, "publish.yml"), "utf8"));

/** The literal block of the `run: |` of the step named `name` in `job`. */
function stepScript(job: string, name: string): string {
  const lines = job.split("\n");
  const at = lines.findIndex((l) => new RegExp(`^\\s*- name:\\s*${name}\\s*$`).test(l));
  assert.ok(at >= 0, `no step named ${name}`);
  const stepIndent = indentOf(lines[at]!);
  const run = lines.findIndex((l, i) => i > at && /^\s*run:\s*\|\s*$/.test(l));
  assert.ok(run > at, `step ${name} has no \`run: |\` block`);
  assert.ok(!lines.slice(at + 1, run).some((l) => l.trim() !== "" && indentOf(l) <= stepIndent), `\`run: |\` after ${name} belongs to another step`);
  const runIndent = indentOf(lines[run]!);
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== "" && indentOf(line) <= runIndent) break;
    body.push(line);
  }
  const strip = Math.min(...body.filter((l) => l.trim() !== "").map(indentOf));
  return body.map((l) => l.slice(strip)).join("\n");
}

/** `name: value` pairs of the `env:` block of the step named `name` in `job`. */
function stepEnv(job: string, name: string): Record<string, string> {
  const lines = job.split("\n");
  const at = lines.findIndex((l) => new RegExp(`^\\s*- name:\\s*${name}\\s*$`).test(l));
  assert.ok(at >= 0, `no step named ${name}`);
  const keyIndent = indentOf(lines[at]!) + 2;
  const step: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== "" && indentOf(line) < keyIndent) break;
    step.push(line);
  }
  return mapEntries(block(step.join("\n"), "env", keyIndent));
}

const all = jobs(publish);
const [, job] = [...all][0] ?? ["", ""];
const jobYaml = `job:\n${job}`;

const SHA = "6ab0ef3fcd436dbd8075c030382ee75b6005a10b";
const ROLE = "corpus-ranker-registry-push";
const SECRET = "/v1/kv/data/corpus-ranker/acr-push";
const OIDC_REQUEST_TOKEN = "gh-request-" + "R".repeat(32);
const OIDC_JWT = "eyJ" + "J".repeat(60);
const BAO_TOKEN = "hvs." + "B".repeat(40);
const PASSWORD = "acr-" + "P".repeat(40);

interface Creds {
  registry: string;
  username: string;
  password: string;
}

/**
 * One local server standing in for the GitHub OIDC token endpoint (GET
 * /oidc?audience=...) and OpenBao. OpenBao only accepts the JWT minted for
 * audience openbao, only under role corpus-ranker-registry-push, and only
 * serves the secret to the token that login issued — as the estate role does.
 */
async function fakeEstate(t: { after: (fn: () => void) => void }, creds: Creds): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      requests.push(`${req.method} ${url.pathname}`);
      const send = (status: number, json: unknown): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (req.method === "GET" && url.pathname === "/oidc") {
        if (req.headers.authorization !== `Bearer ${OIDC_REQUEST_TOKEN}`) return send(401, {});
        if (url.searchParams.get("audience") !== "openbao") return send(200, { value: "jwt-for-another-audience" });
        return send(200, { value: OIDC_JWT });
      }
      if (req.method === "POST" && url.pathname === "/v1/auth/jwt/login") {
        const { role, jwt } = JSON.parse(body || "{}") as { role?: string; jwt?: string };
        if (role !== ROLE || jwt !== OIDC_JWT) return send(403, { errors: ["permission denied"] });
        return send(200, { auth: { client_token: BAO_TOKEN } });
      }
      if (req.method === "GET" && url.pathname === SECRET) {
        if (req.headers["x-vault-token"] !== BAO_TOKEN) return send(403, { errors: ["permission denied"] });
        return send(200, { data: { data: creds, metadata: { version: 1 } } });
      }
      if (req.method === "POST" && url.pathname === "/v1/auth/token/revoke-self") return send(204, {});
      return send(404, { errors: [] });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests };
}

interface PublishRun {
  status: number | null;
  output: string;
  calls: string[];
  requests: string[];
  loginStdin?: string;
}

/**
 * Run the Publish step's script as GitHub would (`bash -e`, from the
 * checkout), with the job's and step's env, a stand-in `docker` that logs
 * argv and the login's stdin, and the fake estate. A decoy /etc/registry-push
 * style directory is exported as REGISTRY_PUSH_DIR: the step must not use it.
 */
async function runPublish(t: { after: (fn: () => void) => void }, creds: Creds, opts: { role?: string } = {}): Promise<PublishRun> {
  const estate = await fakeEstate(t, creds);
  const dir = mkdtempSync(join(tmpdir(), "publish-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const decoy = join(dir, "registry-push");
  const runnerTemp = join(dir, "tmp");
  for (const d of [bin, decoy, runnerTemp]) mkdirSync(d);
  writeFileSync(join(decoy, "registry"), `${REGISTRY}\n`);
  writeFileSync(join(decoy, "username"), "mounted-user\n");
  writeFileSync(join(decoy, "password"), "mounted-password\n");
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh\necho "$*" >> "${dir}/calls"\ncase "$1" in login) cat > "${dir}/login-stdin" ;; esac\nexit 0\n`,
  );
  chmodSync(join(bin, "docker"), 0o755);

  const jobEnv = mapEntries(block(jobYaml, "env", 4));
  const env = stepEnv(job, "Publish");
  assert.equal(env.OPENBAO_ADDR, "${{ vars.OPENBAO_ADDR }}", "OPENBAO_ADDR comes from the repository variable");
  let script = stepScript(job, "Publish");
  // Exercise a role other than the bound one by renaming it in the script under test.
  const scriptPath = join(dir, "estate-registry-credential.mjs");
  const source = readFileSync(resolve(repoRoot, ".github", "scripts", "estate-registry-credential.mjs"), "utf8");
  writeFileSync(scriptPath, opts.role ? source.replaceAll(ROLE, opts.role) : source);
  script = script.replaceAll(".github/scripts/estate-registry-credential.mjs", scriptPath);

  const child = spawn("bash", ["-e", "-c", script], {
    cwd: repoRoot,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      ...jobEnv,
      OPENBAO_ADDR: estate.url,
      ACTIONS_ID_TOKEN_REQUEST_URL: `${estate.url}/oidc?api-version=2.0`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: OIDC_REQUEST_TOKEN,
      REGISTRY_PUSH_DIR: decoy,
      RUNNER_TEMP: runnerTemp,
      GITHUB_SHA: SHA,
    },
  });
  let output = "";
  child.stdout.on("data", (c: Buffer) => (output += c.toString()));
  child.stderr.on("data", (c: Buffer) => (output += c.toString()));
  const [status] = (await once(child, "close")) as [number | null];
  const read = (f: string): string | undefined => {
    try {
      return readFileSync(join(dir, f), "utf8");
    } catch {
      return undefined;
    }
  };
  return {
    status,
    output,
    calls: (read("calls") ?? "").trim().split("\n").filter(Boolean),
    requests: estate.requests,
    loginStdin: read("login-stdin"),
  };
}

test("publish logs in through OpenBao JWT role corpus-ranker-registry-push and never reads the runner mount", async (t) => {
  // Trigger: push to main, and nothing else (in particular, never a PR).
  const on = block(publish, "on", 0);
  assert.ok(on.length > 0, "publish.yml has an `on:` block");
  const triggers = on
    .slice(1)
    .filter((line) => indentOf(line) === 2)
    .map((line) => line.trim().replace(/:.*$/, ""));
  assert.deepEqual(triggers, ["push"], "only `push` triggers the publish workflow");
  const branches = on.join("\n").match(/branches:\s*\[([^\]]*)\]/)?.[1];
  assert.equal(branches?.split(",").map((b) => b.trim()).join(","), "main", "push is limited to main");
  assert.doesNotMatch(publish, /pull_request|workflow_run|repository_dispatch/);

  // Token scope: workflow default is none; the job reads contents for
  // checkout and may mint an OIDC token, and writes nothing on GitHub.
  assert.match(publish, /^permissions:\s*\{\}\s*$/m);
  assert.equal(all.size, 1, "exactly one job: the image is built once per merge");
  assert.deepEqual(
    mapEntries(block(jobYaml, "permissions", 4)),
    { contents: "read", "id-token": "write" },
    "contents: read and id-token: write only; no packages: write",
  );
  assert.doesNotMatch(publish, /packages:/, "no packages permission");

  // Placement: unchanged, the ranker's dedicated runner. Every requested
  // label must be one that runner carries, or the job queues forever.
  const runsOn = /^ {4}runs-on:\s*\[([^\]]*)\]/m
    .exec(job)
    ?.[1]?.split(",")
    .map((label) => label.trim());
  assert.deepEqual(runsOn, ["self-hosted", "corpus-ranker-ci"], "runs-on is [self-hosted, corpus-ranker-ci]");
  assert.deepEqual(runsOn.filter((l) => !RUNNER_LABELS.includes(l)), []);

  // The runner mount is gone: nothing names it or its directory variable.
  assert.doesNotMatch(publish, /\/etc\/registry-push/, "publish.yml does not read the runner mount /etc/registry-push");
  assert.doesNotMatch(publish, /REGISTRY_PUSH_DIR/, "publish.yml does not read REGISTRY_PUSH_DIR");

  // No GitHub registry and no GitHub-held secret: the credential comes from OpenBao.
  assert.doesNotMatch(publish, /ghcr\.io/, "nothing logs in to or pushes to ghcr.io");
  assert.doesNotMatch(publish, /secrets\./, "no repository secret: the push token is fetched from OpenBao per run");

  // Build once, tag with the commit SHA, push only that tag to ACR.
  assert.match(publish, new RegExp(`IMAGE:\\s*${IMAGE.replace(/\./g, "\\.")}\\s*$`, "m"));
  assert.equal(publish.match(/docker build\b/g)?.length, 1, "one docker build");
  assert.match(publish, /-t "\$\{IMAGE\}:sha-\$\{GITHUB_SHA\}"/);
  const pushes = [...publish.matchAll(/docker push\s+(\S+)/g)].map((m) => m[1]);
  assert.deepEqual(pushes, ['"${IMAGE}:sha-${GITHUB_SHA}"'], "only the SHA tag is pushed");

  // Once per merge: no concurrency group anywhere. A group keeps at most one
  // pending run, so with A running and B pending a merge C cancels B even
  // with `cancel-in-progress: false`, and B's SHA would go unpublished.
  assert.doesNotMatch(publish, /^\s*concurrency:/m, "no concurrency group may drop a queued merge's run");

  // Run the Publish step: OIDC (audience openbao) -> OpenBao JWT login with
  // the bound role -> read the push token -> docker login to the registry it
  // names, as its user, password on stdin -> push the SHA tag -> log out.
  const ok = await runPublish(t, { registry: REGISTRY, username: "corpus-ranker-push", password: PASSWORD });
  assert.equal(ok.status, 0, ok.output);
  assert.deepEqual(ok.requests, ["GET /oidc", "POST /v1/auth/jwt/login", `GET ${SECRET}`, "POST /v1/auth/token/revoke-self"]);
  assert.deepEqual(ok.calls, [
    `login ${REGISTRY} -u corpus-ranker-push --password-stdin`,
    `push ${IMAGE}:sha-${SHA}`,
    `logout ${REGISTRY}`,
  ]);
  assert.equal(ok.loginStdin, PASSWORD, "the fetched password reaches docker login on stdin");
  assert.doesNotMatch(ok.calls.join(" "), /mounted-/, "nothing from the runner mount is used");
  for (const secret of [PASSWORD, BAO_TOKEN, OIDC_JWT, OIDC_REQUEST_TOKEN]) {
    assert.ok(!ok.calls.join(" ").includes(secret), "no token or password goes on argv");
    assert.ok(!ok.output.includes(secret), "no token or password is printed");
  }

  // A role OpenBao does not bind is refused, and nothing is pushed.
  const wrongRole = await runPublish(t, { registry: REGISTRY, username: "corpus-ranker-push", password: PASSWORD }, { role: "some-other-role" });
  assert.notEqual(wrongRole.status, 0, "a login OpenBao refuses must fail the step");
  assert.deepEqual(wrongRole.calls.filter((c) => !c.startsWith("logout")), [], "nothing is logged in to or pushed without the OpenBao credential");

  // A credential for another registry is refused before any login or push.
  const wrong = await runPublish(t, { registry: "ghcr.io", username: "u", password: PASSWORD });
  assert.notEqual(wrong.status, 0, "a push credential for another registry must fail the step");
  assert.deepEqual(wrong.calls.filter((c) => !c.startsWith("logout")), [], "nothing is logged in to or pushed with a mismatched credential");
  assert.ok(!wrong.output.includes(PASSWORD), "the password is not printed on refusal");
});

test("ci.yml no longer publishes, so each merge to main pushes the image exactly once", () => {
  const ci = stripComments(readFileSync(resolve(workflowsDir, "ci.yml"), "utf8"));
  assert.doesNotMatch(ci, /docker push|docker login/);
  assert.doesNotMatch(ci, /packages:\s*write/);
  assert.doesNotMatch(ci, /self-hosted/, "ci.yml (which runs PRs) stays off self-hosted runners");
});
