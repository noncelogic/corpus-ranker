// CR-IMAGE-ACR acceptance (INTENTS I21; Rule: policies/placement-defaults.yaml#credentials):
// .github/workflows/publish.yml builds the ranker image once per merge to
// main on the ranker's dedicated self-hosted runner (labels self-hosted, aks,
// corpus-ranker-ci) and pushes it to the estate Azure registry as
// noncelogicci.azurecr.io/corpus-ranker:sha-<commit>. It logs in with the
// ranker's own ACR push token, mounted read-only on that runner at
// /etc/registry-push (files registry, username, password), the password on
// stdin. It no longer touches ghcr.io and holds no `packages: write`.
//
// Self-hosted runners hold estate credentials (docs/EXTERNAL-REVIEW.md §1),
// so the workflow must not be reachable from pull requests at all. ci.yml
// stays on GitHub-hosted runners and no longer publishes, so each merge
// yields exactly one publish.
//
// The workflow YAML is inspected with a narrow line scanner rather than a
// YAML library, to avoid a new dependency (docs/EXTERNAL-REVIEW.md §3). The
// Publish step's script is then run as written, against a stand-in `docker`
// and a stand-in credential directory.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowsDir = resolve(repoRoot, ".github", "workflows");
const REGISTRY = "noncelogicci.azurecr.io";
const IMAGE = `${REGISTRY}/corpus-ranker`;
const CREDENTIAL_DIR = "/etc/registry-push";
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

const all = jobs(publish);
const [, job] = [...all][0] ?? ["", ""];
const jobYaml = `job:\n${job}`;

interface PublishRun {
  status: number | null;
  stderr: string;
  calls: string[];
  loginStdin?: string;
}

/**
 * Run the Publish step's script as GitHub would (`bash -e`), with the job's
 * env, a stand-in `docker` that logs argv and the login's stdin, and the
 * credential files written into a stand-in for /etc/registry-push.
 */
function runPublish(t: { after: (fn: () => void) => void }, creds: { registry: string; username: string; password: string }): PublishRun {
  const dir = mkdtempSync(join(tmpdir(), "publish-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const credDir = join(dir, "registry-push");
  const runnerTemp = join(dir, "tmp");
  for (const d of [bin, credDir, runnerTemp]) mkdirSync(d);
  writeFileSync(join(credDir, "registry"), `${creds.registry}\n`);
  writeFileSync(join(credDir, "username"), `${creds.username}\n`);
  writeFileSync(join(credDir, "password"), `${creds.password}\n`);
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/sh\necho "$*" >> "${dir}/calls"\ncase "$1" in login) cat > "${dir}/login-stdin" ;; esac\nexit 0\n`,
  );
  chmodSync(join(bin, "docker"), 0o755);

  const env = mapEntries(block(jobYaml, "env", 4));
  assert.equal(env.REGISTRY_PUSH_DIR, CREDENTIAL_DIR, `the job reads the push credential from ${CREDENTIAL_DIR}`);
  const script = stepScript(job, "Publish");
  const run = spawnSync("bash", ["-e", "-c", script], {
    env: { PATH: `${bin}:${process.env.PATH}`, ...env, REGISTRY_PUSH_DIR: credDir, RUNNER_TEMP: runnerTemp, GITHUB_SHA: SHA },
    encoding: "utf8",
  });
  const read = (f: string): string | undefined => {
    try {
      return readFileSync(join(dir, f), "utf8");
    } catch {
      return undefined;
    }
  };
  return { status: run.status, stderr: run.stderr, calls: (read("calls") ?? "").trim().split("\n").filter(Boolean), loginStdin: read("login-stdin") };
}

const SHA = "6ab0ef3fcd436dbd8075c030382ee75b6005a10b";

test("publish pushes noncelogicci.azurecr.io/corpus-ranker:sha-<commit> with the /etc/registry-push credential on the corpus-ranker-ci runner", (t) => {
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
  // checkout and writes nothing on GitHub (the registry push is ACR's own token).
  assert.match(publish, /^permissions:\s*\{\}\s*$/m);
  assert.equal(all.size, 1, "exactly one job: the image is built once per merge");
  assert.deepEqual(mapEntries(block(jobYaml, "permissions", 4)), { contents: "read" }, "contents: read only; no packages: write");
  assert.doesNotMatch(publish, /packages:/, "no packages permission");

  // Placement: the ranker's dedicated runner, which holds /etc/registry-push.
  // Every requested label must be one that runner carries, or the job queues forever.
  const runsOn = /^ {4}runs-on:\s*\[([^\]]*)\]/m
    .exec(job)
    ?.[1]?.split(",")
    .map((label) => label.trim());
  assert.deepEqual(runsOn, ["self-hosted", "corpus-ranker-ci"], "runs-on is [self-hosted, corpus-ranker-ci]");
  assert.deepEqual(runsOn.filter((l) => !RUNNER_LABELS.includes(l)), []);

  // No GitHub registry and no GitHub-held secret: the credential is the mounted ACR push token.
  assert.doesNotMatch(publish, /ghcr\.io/, "nothing logs in to or pushes to ghcr.io");
  assert.doesNotMatch(publish, /secrets\./, "no repository secret: the push token is the runner's mounted credential");

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

  // Run the Publish step: it logs in to the registry the file names, as the
  // file's user, with the file's password on stdin, pushes the SHA tag and logs out.
  const password = "acr-" + "P".repeat(40);
  const ok = runPublish(t, { registry: REGISTRY, username: "corpus-ranker-push", password });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(ok.calls, [
    `login ${REGISTRY} -u corpus-ranker-push --password-stdin`,
    `push ${IMAGE}:sha-${SHA}`,
    `logout ${REGISTRY}`,
  ]);
  assert.equal(ok.loginStdin?.trim(), password, "the password reaches docker login on stdin");
  assert.ok(!ok.calls.join(" ").includes(password), "the password never goes on argv");
  assert.ok(!ok.stderr.includes(password), "the password is never echoed");

  // A credential for another registry is refused before any login or push.
  const wrong = runPublish(t, { registry: "ghcr.io", username: "u", password });
  assert.notEqual(wrong.status, 0, "a push credential for another registry must fail the step");
  assert.deepEqual(wrong.calls.filter((c) => !c.startsWith("logout")), [], "nothing is logged in to or pushed with a mismatched credential");
});

test("ci.yml no longer publishes, so each merge to main pushes the image exactly once", () => {
  const ci = stripComments(readFileSync(resolve(workflowsDir, "ci.yml"), "utf8"));
  assert.doesNotMatch(ci, /docker push|docker login/);
  assert.doesNotMatch(ci, /packages:\s*write/);
  assert.doesNotMatch(ci, /self-hosted/, "ci.yml (which runs PRs) stays off self-hosted runners");
});
