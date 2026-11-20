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
// The workflows are run whole, as written, by a local runner
// (tests/ci/workflow-runner.ts) for a push to main or a pull request, against
// stand-in `docker`, `npm` and `kustomize` binaries that record what they are
// asked to do, and one local HTTP server standing in for both the GitHub OIDC
// token endpoint and OpenBao. Refusals are the fake estate's behaviour; the
// production workflow and credential script are never edited.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runEvent, type JobRun, type WorkflowEvent } from "./workflow-runner.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowsDir = resolve(repoRoot, ".github", "workflows");
const REGISTRY = "noncelogicci.azurecr.io";
const IMAGE = `${REGISTRY}/corpus-ranker`;
/** Labels the ranker's dedicated runner carries (meta-harness devops/aks/corpus-ranker-argo/README.md). */
const RUNNER_LABELS = ["self-hosted", "aks", "corpus-ranker-ci"];

const SHA = "6ab0ef3fcd436dbd8075c030382ee75b6005a10b";
const PUSH_MAIN: WorkflowEvent = { name: "push", ref: "refs/heads/main", sha: SHA };
const PULL_REQUEST: WorkflowEvent = { name: "pull_request", ref: "refs/pull/64/merge", sha: SHA };
const ROLE = "corpus-ranker-registry-push";
const SECRET = "/v1/kv/data/corpus-ranker/acr-push";
const OIDC_REQUEST_TOKEN = "gh-request-" + "R".repeat(32);
const OIDC_JWT = "eyJ" + "J".repeat(60);
const BAO_TOKEN = "hvs." + "B".repeat(40);
const PASSWORD = "acr-" + "P".repeat(40);
const GOOD = { registry: REGISTRY, username: "corpus-ranker-push", password: PASSWORD };

interface Estate {
  creds: { registry: string; username: string; password: string };
  /** OpenBao refuses every auth/jwt login (e.g. the role's bound claims do not match). */
  refuseLogin?: boolean;
}

/**
 * One local server standing in for the GitHub OIDC token endpoint (GET
 * /oidc?audience=...) and OpenBao. OpenBao only accepts the JWT minted for
 * audience openbao, only under role corpus-ranker-registry-push, and only
 * serves the secret to the token that login issued, as the estate role does.
 */
async function fakeEstate(t: TestContext, estate: Estate): Promise<{ url: string; requests: string[] }> {
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
        if (estate.refuseLogin || role !== ROLE || jwt !== OIDC_JWT) return send(403, { errors: ["permission denied"] });
        return send(200, { auth: { client_token: BAO_TOKEN } });
      }
      if (req.method === "GET" && url.pathname === SECRET) {
        if (req.headers["x-vault-token"] !== BAO_TOKEN) return send(403, { errors: ["permission denied"] });
        return send(200, { data: { data: estate.creds, metadata: { version: 1 } } });
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

interface Simulation {
  jobs: JobRun[];
  /** Every docker/npm/kustomize invocation, in order, as "<tool> <argv>". */
  calls: string[];
  requests: string[];
  loginStdin?: string;
  output: string;
}

/**
 * Run the repository's workflows for `event` on the local runner. Stand-in
 * docker, npm and kustomize record their argv (and docker login's stdin). A
 * decoy of the old runner mount, holding a different credential, is offered
 * to every step as REGISTRY_PUSH_DIR: nothing may use it.
 */
async function simulate(t: TestContext, event: WorkflowEvent, estate: Estate, workflows?: string[]): Promise<Simulation> {
  const fake = await fakeEstate(t, estate);
  const dir = mkdtempSync(join(tmpdir(), "publish-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const decoy = join(dir, "registry-push");
  for (const d of [bin, decoy]) mkdirSync(d);
  writeFileSync(join(decoy, "registry"), `${REGISTRY}\n`);
  writeFileSync(join(decoy, "username"), "mounted-user\n");
  writeFileSync(join(decoy, "password"), "mounted-password\n");
  for (const tool of ["docker", "npm", "kustomize"]) {
    writeFileSync(
      join(bin, tool),
      `#!/bin/sh\necho "${tool} $*" >> "${dir}/calls"\n` +
        (tool === "docker" ? `case "$1" in login) cat > "${dir}/login-stdin" ;; esac\n` : "") +
        "exit 0\n",
    );
    chmodSync(join(bin, tool), 0o755);
  }

  const jobs = await runEvent({
    workflowsDir,
    workflows,
    event,
    workspace: repoRoot,
    repository: "noncelogic/corpus-ranker",
    vars: { OPENBAO_ADDR: fake.url },
    hostEnv: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, REGISTRY_PUSH_DIR: decoy },
    oidc: { url: `${fake.url}/oidc?api-version=2.0`, token: OIDC_REQUEST_TOKEN },
  });
  const read = (f: string): string | undefined => {
    try {
      return readFileSync(join(dir, f), "utf8");
    } catch {
      return undefined;
    }
  };
  return {
    jobs,
    calls: (read("calls") ?? "").trim().split("\n").filter(Boolean),
    requests: fake.requests,
    loginStdin: read("login-stdin"),
    output: jobs.flatMap((j) => j.steps.map((s) => s.output)).join("\n"),
  };
}

const publishJob = (sim: Simulation): JobRun => {
  const jobs = sim.jobs.filter((j) => j.workflow === "publish.yml");
  assert.equal(jobs.length, 1, "publish.yml has exactly one job");
  return jobs[0]!;
};

test("publish logs in through OpenBao JWT role corpus-ranker-registry-push and never reads the runner mount", async (t) => {
  // The runner mount is gone from the workflow (the defect this task removes).
  const source = readFileSync(resolve(workflowsDir, "publish.yml"), "utf8");
  assert.doesNotMatch(source, /\/etc\/registry-push/, "publish.yml does not read the runner mount /etc/registry-push");
  assert.doesNotMatch(source, /REGISTRY_PUSH_DIR/, "publish.yml does not read REGISTRY_PUSH_DIR");

  // A push to main runs publish.yml as written: OIDC (audience openbao) ->
  // OpenBao JWT login with the bound role -> read the push token -> docker
  // login to the registry it names, password on stdin -> push the SHA tag ->
  // log out.
  const ok = await simulate(t, PUSH_MAIN, { creds: GOOD }, ["publish.yml"]);
  const job = publishJob(ok);
  assert.equal(job.status, "success", ok.output);
  assert.deepEqual(job.runsOn, ["self-hosted", "corpus-ranker-ci"], "runs-on stays [self-hosted, corpus-ranker-ci]");
  assert.deepEqual((job.runsOn as string[]).filter((l) => !RUNNER_LABELS.includes(l)), [], "every label is one the ranker's runner carries");
  assert.deepEqual(job.permissions, { contents: "read", "id-token": "write" }, "contents: read and id-token: write only; no packages");
  assert.ok(job.oidcOffered, "the job is granted id-token: write, so it can mint the OIDC token");
  assert.deepEqual(ok.requests, ["GET /oidc", "POST /v1/auth/jwt/login", `GET ${SECRET}`, "POST /v1/auth/token/revoke-self"]);
  assert.equal(ok.calls.length, 4, ok.calls.join("\n"));
  assert.match(ok.calls[0]!, new RegExp(`^docker build .* -t ${IMAGE}:sha-${SHA} \\.$`), "builds the SHA-tagged image");
  assert.deepEqual(ok.calls.slice(1), [
    `docker login ${REGISTRY} -u corpus-ranker-push --password-stdin`,
    `docker push ${IMAGE}:sha-${SHA}`,
    `docker logout ${REGISTRY}`,
  ]);
  assert.equal(ok.loginStdin, PASSWORD, "the fetched password reaches docker login on stdin");
  assert.doesNotMatch(ok.calls.join(" "), /mounted-/, "nothing from the runner mount is used");
  for (const secret of [PASSWORD, BAO_TOKEN, OIDC_JWT, OIDC_REQUEST_TOKEN]) {
    assert.ok(!ok.calls.join(" ").includes(secret), "no token or password goes on argv");
    assert.ok(!ok.output.includes(secret), "no token or password is printed");
  }

  // OpenBao refuses the login (e.g. the role's bound claims do not match):
  // the job fails, no secret is read, nothing is logged in to or pushed.
  const refused = await simulate(t, PUSH_MAIN, { creds: GOOD, refuseLogin: true }, ["publish.yml"]);
  assert.equal(publishJob(refused).status, "failure", "a login OpenBao refuses must fail the job");
  assert.deepEqual(refused.requests, ["GET /oidc", "POST /v1/auth/jwt/login"]);
  assert.deepEqual(refused.calls.filter((c) => !/^docker (build|logout) /.test(c)), [], "nothing is logged in to or pushed without the OpenBao credential");
  assert.ok(!refused.output.includes(OIDC_JWT), "the OIDC token is not printed on refusal");

  // A credential for another registry is refused before any login or push.
  const wrong = await simulate(t, PUSH_MAIN, { creds: { registry: "ghcr.io", username: "u", password: PASSWORD } }, ["publish.yml"]);
  assert.equal(publishJob(wrong).status, "failure", "a push credential for another registry must fail the job");
  assert.deepEqual(wrong.calls.filter((c) => !/^docker (build|logout) /.test(c)), [], "nothing is logged in to or pushed with a mismatched credential");
  assert.ok(!wrong.output.includes(PASSWORD), "the password is not printed on refusal");
});

test("ci.yml no longer publishes, so each merge to main pushes the image exactly once", async (t) => {
  // A merge to main: every workflow it triggers runs, and exactly one image
  // push happens in total — publish.yml's SHA tag. ci.yml's image job only
  // builds (the pull-request dry run) and its ci-result gate (if: always())
  // reads every need's result.
  const merge = await simulate(t, PUSH_MAIN, { creds: GOOD });
  const ran = merge.jobs.filter((j) => j.status !== "skipped").map((j) => `${j.workflow}/${j.job}`);
  assert.deepEqual(ran.sort(), ["ci.yml/ci-result", "ci.yml/image", "ci.yml/test", "publish.yml/image"], merge.output);
  assert.ok(merge.jobs.every((j) => j.status !== "failure"), merge.output);
  assert.deepEqual(merge.calls.filter((c) => c.startsWith("docker push ")), [`docker push ${IMAGE}:sha-${SHA}`], "one push per merge");
  assert.equal(merge.calls.filter((c) => c.startsWith("docker login ")).length, 1, "one registry login per merge");
  assert.equal(merge.requests.filter((r) => r === "POST /v1/auth/jwt/login").length, 1, "one OpenBao login per merge");

  // A pull request: publish.yml does not run at all, nothing logs in or
  // pushes, no OIDC token is minted, and no job lands on a self-hosted runner.
  const pr = await simulate(t, PULL_REQUEST, { creds: GOOD });
  assert.ok(pr.jobs.length > 0, "ci.yml runs for pull requests");
  assert.deepEqual(pr.jobs.filter((j) => j.workflow === "publish.yml"), [], "publish.yml is not triggered by a pull request");
  assert.ok(pr.jobs.every((j) => j.status !== "failure"), pr.output);
  assert.deepEqual(pr.calls.filter((c) => /^docker (push|login) /.test(c)), [], "a pull request pushes nothing");
  assert.deepEqual(pr.requests, [], "a pull request never reaches the OIDC endpoint or OpenBao");
  assert.ok(pr.calls.some((c) => c.startsWith("docker build ")), "the pull request still builds the image");
  for (const j of pr.jobs) {
    assert.ok(!JSON.stringify(j.runsOn).includes("self-hosted"), `${j.workflow}/${j.job} stays off self-hosted runners`);
  }
});
