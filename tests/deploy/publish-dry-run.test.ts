// COND-219 acceptance (policy main-stays-green v1): publish.yml's `image` job
// acts only on main (it pushes to the estate Azure registry from the
// corpus-ranker-ci self-hosted runner), so a pull-request dry run of it must
// validate the same inputs without the side effect, and the main job must
// tolerate the external delays it depends on.
//
// - ci.yml has exactly one job declaring `env: DRY_RUN_OF: image`. It runs on
//   pull requests, on a GitHub-hosted runner (never self-hosted: PR code must
//   not reach estate credentials, docs/EXTERNAL-REVIEW.md §1), with a
//   read-only token, and never logs in or pushes.
// - Its Build step is the publish job's Build step, character for character,
//   with the same IMAGE, so the dry run builds the same Dockerfile with the
//   same tag and OCI metadata. It then checks that metadata on the built image.
// - The required-check row in docs/EXTERNAL-REVIEW.md names the dry run.
// - publish.yml's Build and Publish steps wrap their registry calls (base image
//   pull during the build, login, push) in .github/scripts/retry.sh: a
//   bounded wait (attempt cap, doubling delay) that fails loudly at the cap.
//   The main run of 2026-11-19 (run 44630865667) went red on a Docker Hub
//   `429 Too Many Requests` while resolving the base image.
//
// Workflows are read with a narrow line scanner (no YAML dependency,
// docs/EXTERNAL-REVIEW.md §3); scripts are run as written against stand-ins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowsDir = resolve(repoRoot, ".github", "workflows");
const RETRY = ".github/scripts/retry.sh";
const IMAGE = "noncelogicci.azurecr.io/corpus-ranker";
const SHA = "0ef52d2f71ea72cc47919fe9424a3d834c0a1279";

/** Drop full-line and trailing comments so prose cannot satisfy a check. */
function stripComments(yaml: string): string {
  return yaml
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+#.*$/, ""))
    .join("\n");
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** The lines nested under the first top-level `key:`. */
function topBlock(yaml: string, key: string): string[] {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start < 0) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim() !== "" && indentOf(line) === 0) break;
    out.push(line);
  }
  return out;
}

/** Split `jobs:` into its job bodies, keyed by job id. */
function jobs(yaml: string): Map<string, string> {
  const out = new Map<string, string>();
  let current: string | undefined;
  for (const line of topBlock(yaml, "jobs")) {
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

/** A job-level (4-space) `key: value`, or undefined. */
function jobKey(body: string, key: string): string | undefined {
  const m = new RegExp(`^ {4}${key}:\\s*(.*)$`, "m").exec(body);
  return m ? m[1]!.trim() : undefined;
}

/** `name: value` pairs of a job-level map (`env:`, `permissions:`). */
function jobMap(body: string, key: string): Record<string, string> {
  const lines = body.split("\n");
  const at = lines.findIndex((l) => new RegExp(`^ {4}${key}:\\s*$`).test(l));
  const out: Record<string, string> = {};
  if (at < 0) return out;
  for (const line of lines.slice(at + 1)) {
    if (line.trim() !== "" && indentOf(line) <= 4) break;
    const m = /^ {6}([\w-]+):\s*(\S.*)?$/.exec(line);
    if (m) out[m[1]!] = (m[2] ?? "").trim();
  }
  return out;
}

/** The literal block of the `run: |` of the step named `name`. */
function stepScript(body: string, name: string): string {
  const lines = body.split("\n");
  const at = lines.findIndex((l) => new RegExp(`^\\s*- name:\\s*${name}\\s*$`).test(l));
  assert.ok(at >= 0, `no step named ${name}`);
  const stepIndent = indentOf(lines[at]!);
  const run = lines.findIndex((l, i) => i > at && /^\s*run:\s*\|\s*$/.test(l));
  assert.ok(run > at, `step ${name} has no \`run: |\` block`);
  assert.ok(!lines.slice(at + 1, run).some((l) => l.trim() !== "" && indentOf(l) <= stepIndent), `\`run: |\` after ${name} belongs to another step`);
  const runIndent = indentOf(lines[run]!);
  const script: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== "" && indentOf(line) <= runIndent) break;
    script.push(line);
  }
  const strip = Math.min(...script.filter((l) => l.trim() !== "").map(indentOf));
  return script.map((l) => l.slice(strip)).join("\n").trimEnd();
}

const ci = stripComments(readFileSync(resolve(workflowsDir, "ci.yml"), "utf8"));
const publish = stripComments(readFileSync(resolve(workflowsDir, "publish.yml"), "utf8"));
const ciJobs = jobs(ci);
const publishJob = jobs(publish).get("image") ?? "";

function dryRunJob(): [string, string] {
  const found = [...ciJobs].filter(([, body]) => jobMap(body, "env").DRY_RUN_OF === "image");
  assert.equal(found.length, 1, "ci.yml has exactly one job with env DRY_RUN_OF: image");
  return found[0]!;
}

interface Run {
  status: number | null;
  stderr: string;
  calls: string[];
}

/** Run `script` under `bash -e` from the repo root with a stand-in `docker`. */
function runWithDocker(
  t: { after: (fn: () => void) => void },
  script: string,
  env: Record<string, string>,
  docker: string,
): Run {
  const dir = mkdtempSync(join(tmpdir(), "dry-run-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), `#!/bin/bash\necho "$*" >> "${dir}/calls"\n${docker}\n`);
  chmodSync(join(bin, "docker"), 0o755);
  const run = spawnSync("bash", ["-e", "-c", script], {
    cwd: repoRoot,
    env: { PATH: `${bin}:${process.env.PATH}`, RETRY_DELAY_SECONDS: "0", STATE: dir, ...env },
    encoding: "utf8",
  });
  let calls: string[] = [];
  try {
    calls = readFileSync(join(dir, "calls"), "utf8").trim().split("\n").filter(Boolean);
  } catch {
    /* no docker call */
  }
  return { status: run.status, stderr: run.stderr, calls };
}

test("ci.yml has a pull-request dry run of publish.yml's image job, without the side effect", () => {
  const [id, body] = dryRunJob();
  const on = topBlock(ci, "on").join("\n");
  assert.match(on, /^ {2}pull_request:/m, "ci.yml runs on pull requests");
  assert.doesNotMatch(on, /pull_request_target/);
  const cond = jobKey(body, "if");
  if (cond !== undefined) assert.match(cond, /pull_request/, `${id} must run on pull requests, not \`if: ${cond}\``);

  // No side effect and no reach into the estate.
  assert.doesNotMatch(jobKey(body, "runs-on") ?? "", /self-hosted/, `${id} stays off self-hosted runners`);
  assert.doesNotMatch(body, /docker (push|login)|secrets\.|registry-push/, `${id} never logs in or pushes`);
  assert.match(ci, /^permissions:\s*\n\s+contents:\s*read\s*$/m, "ci.yml's token is read-only");
  const perms = jobMap(body, "permissions");
  for (const [scope, level] of Object.entries(perms)) assert.notEqual(level, "write", `${id} holds ${scope}: write`);

  // Same inputs: the same image name and the very same Build step.
  assert.equal(jobMap(body, "env").IMAGE, IMAGE, `${id} builds ${IMAGE}, as publish does`);
  assert.equal(jobMap(publishJob, "env").IMAGE, IMAGE);
  assert.equal(stepScript(body, "Build"), stepScript(publishJob, "Build"), `${id}'s Build step must be publish.yml's Build step`);
});

test("the dry run checks the built image's tag and OCI metadata", (t) => {
  const [, body] = dryRunJob();
  const script = stepScript(body, "Check image metadata");
  const env = { IMAGE, GITHUB_SHA: SHA, GITHUB_REPOSITORY: "noncelogic/corpus-ranker" };
  const labels = (source: string, revision: string): string =>
    `echo '{"org.opencontainers.image.source":"${source}","org.opencontainers.image.revision":"${revision}"}'`;

  const ok = runWithDocker(t, script, env, labels("https://github.com/noncelogic/corpus-ranker", SHA));
  assert.equal(ok.status, 0, ok.stderr);
  assert.ok(ok.calls.some((c) => c.startsWith("image inspect") && c.includes(`${IMAGE}:sha-${SHA}`)), `inspects ${IMAGE}:sha-<commit>: ${ok.calls}`);

  const staleRevision = runWithDocker(t, script, env, labels("https://github.com/noncelogic/corpus-ranker", "deadbeef"));
  assert.notEqual(staleRevision.status, 0, "a revision label other than the commit fails the dry run");
  const wrongSource = runWithDocker(t, script, env, labels("https://github.com/someone/else", SHA));
  assert.notEqual(wrongSource.status, 0, "a source label other than this repository fails the dry run");
  const missing = runWithDocker(t, script, env, "exit 1");
  assert.notEqual(missing.status, 0, "a missing image fails the dry run");
});

test("the enforcement map requires the dry run as a pull-request check", () => {
  const [id] = dryRunJob();
  const policy = readFileSync(resolve(repoRoot, "docs", "EXTERNAL-REVIEW.md"), "utf8");
  const row = policy.split("\n").find((l) => l.startsWith("|") && l.includes("DRY_RUN_OF: image"));
  assert.ok(row, "docs/EXTERNAL-REVIEW.md's enforcement map has a row for the image dry run");
  assert.match(row, new RegExp(`required status check[^|]*\`${id}\``), `the row names \`${id}\` as a required status check`);
  assert.match(row, /strict/, "the row states the protection is strict");
});

test("publish.yml's registry calls wait for external delays, boundedly", (t) => {
  for (const [step, call] of [
    ["Build", "docker build"],
    ["Publish", "docker login"],
    ["Publish", "docker push"],
  ] as const) {
    const line = stepScript(publishJob, step)
      .split("\n")
      .find((l) => l.includes(call));
    assert.ok(line, `${step} runs ${call}`);
    assert.ok(line.trimStart().startsWith(`${RETRY} `), `${step}'s ${call} goes through ${RETRY}: ${line}`);
  }
  const budget = Number(jobKey(publishJob, "timeout-minutes"));
  assert.ok(budget > 0 && budget <= 30, "the publish job keeps a timeout");

  // A registry that answers 429 twice and then succeeds: the build gets through.
  const flaky = `n=$(cat "$STATE/n" 2>/dev/null || echo 0); echo $((n+1)) > "$STATE/n"; [ "$n" -ge 2 ] || { echo "429 Too Many Requests" >&2; exit 1; }`;
  const env = { IMAGE, GITHUB_SHA: SHA, GITHUB_REPOSITORY: "noncelogic/corpus-ranker" };
  const recovers = runWithDocker(t, stepScript(publishJob, "Build"), env, flaky);
  assert.equal(recovers.status, 0, recovers.stderr);
  assert.equal(recovers.calls.filter((c) => c.startsWith("build")).length, 3, "two refusals then a build");

  // A registry that never recovers: the wait stops at its cap and fails loudly.
  const down = runWithDocker(t, stepScript(publishJob, "Build"), env, `echo "429 Too Many Requests" >&2; exit 1`);
  assert.notEqual(down.status, 0, "the build fails once the wait is spent");
  const attempts = down.calls.filter((c) => c.startsWith("build")).length;
  assert.ok(attempts > 1 && attempts <= 5, `the build is retried a bounded number of times (got ${attempts})`);
  assert.match(down.stderr, /gave up after \d+ attempts/, "hitting the cap is reported");
});

test("retry.sh: attempt cap, doubling delay within budget, exit status preserved", (t) => {
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("bash", [resolve(repoRoot, RETRY), ...args], {
      cwd: repoRoot,
      env: { PATH: process.env.PATH, RETRY_DELAY_SECONDS: "0", ...env },
      encoding: "utf8",
    });
  const dir = mkdtempSync(join(tmpdir(), "retry-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  assert.equal(run(["true"]).status, 0);
  const fails = run(["sh", "-c", `echo x >> "${dir}/n"; exit 7`], { RETRY_ATTEMPTS: "3" });
  assert.equal(fails.status, 7, "the last attempt's exit status is kept");
  assert.equal(readFileSync(join(dir, "n"), "utf8").trim().split("\n").length, 3, "exactly RETRY_ATTEMPTS attempts");
  assert.match(fails.stderr, /gave up after 3 attempts/);
  assert.notEqual(run([]).status, 0, "no command is a usage error");
  assert.notEqual(run(["true"], { RETRY_ATTEMPTS: "0" }).status, 0, "a non-positive cap is refused");
  assert.notEqual(run(["true"], { RETRY_ATTEMPTS: "50" }).status, 0, "an unbounded cap is refused");

  // Default schedule: the total wait stays well inside the job's timeout.
  const plan = run(["--plan"], { RETRY_DELAY_SECONDS: "" });
  assert.equal(plan.status, 0, plan.stderr);
  const waits = plan.stdout.trim().split(/\s+/).map(Number);
  assert.ok(waits.length >= 2, `the default waits between attempts: ${plan.stdout}`);
  for (let i = 1; i < waits.length; i++) assert.equal(waits[i], waits[i - 1]! * 2, "the delay doubles");
  assert.ok(waits.reduce((a, b) => a + b, 0) <= 300, "the total wait is at most five minutes");
});
