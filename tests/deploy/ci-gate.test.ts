// COND-218 acceptance (policy main-stays-green v1): every job main runs from
// .github/workflows/ci.yml is proven on the pull request first, behind one
// required pull-request check.
//
// - ci.yml runs on pull requests and on pushes to main, and every job in it
//   (including `image`, the pull-request dry run of publish.yml's build) runs
//   on both events: no job is event-gated, so what main runs is exactly what
//   the pull request proved.
// - A `ci-result` job needs every other ci.yml job, runs even when one of
//   them fails, and passes only when all of them succeeded. It is the single
//   name branch protection requires (strict), so a job added to ci.yml later
//   cannot be non-gating without this test failing.
// - docs/EXTERNAL-REVIEW.md's enforcement map names `ci-result` as the
//   required, strict status check on `main`.
//
// The workflow is read with a narrow line scanner (no YAML dependency,
// docs/EXTERNAL-REVIEW.md §3), and the result step's script is run as written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RESULT_JOB = "ci-result";

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

/** The job's `needs:` as a list, in flow (`[a, b]`), scalar or block form. */
function needsOf(body: string): string[] {
  const value = jobKey(body, "needs");
  if (value === undefined) return [];
  if (value.startsWith("[")) return value.replace(/[[\]]/g, "").split(",").map((s) => s.trim()).filter(Boolean);
  if (value !== "") return [value];
  const lines = body.split("\n");
  const at = lines.findIndex((l) => /^ {4}needs:\s*$/.test(l));
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const m = /^ {6}- ([\w-]+)\s*$/.exec(line);
    if (!m) break;
    out.push(m[1]!);
  }
  return out;
}

/** The literal block of the job's single `run: |` step. */
function runScript(body: string): string {
  const lines = body.split("\n");
  const runs = lines.flatMap((l, i) => (/^\s*(- )?run:\s*\|\s*$/.test(l) ? [i] : []));
  assert.equal(runs.length, 1, "the result job has exactly one `run: |` step");
  const runIndent = indentOf(lines[runs[0]!]!.replace("- ", "  "));
  const script: string[] = [];
  for (const line of lines.slice(runs[0]! + 1)) {
    if (line.trim() !== "" && indentOf(line) <= runIndent) break;
    script.push(line);
  }
  const strip = Math.min(...script.filter((l) => l.trim() !== "").map(indentOf));
  return script.map((l) => l.slice(strip)).join("\n");
}

const ci = stripComments(readFileSync(resolve(repoRoot, ".github", "workflows", "ci.yml"), "utf8"));
const ciJobs = jobs(ci);

test("ci.yml runs on pull requests and on pushes to main", () => {
  const on = topBlock(ci, "on").join("\n");
  assert.match(on, /^ {2}pull_request:/m, "ci.yml must run on pull requests");
  assert.match(on, /^ {2}push:\s*\n\s+branches:\s*\[main\]/m, "ci.yml must run on pushes to main");
  assert.doesNotMatch(on, /pull_request_target/);
});

test("every ci.yml job main runs also runs on the pull request (no event-gated jobs)", () => {
  assert.ok(ciJobs.has("image"), "ci.yml keeps the image build job");
  for (const [id, body] of ciJobs) {
    if (id === RESULT_JOB) continue;
    const cond = jobKey(body, "if");
    assert.equal(cond, undefined, `job ${id} is gated by \`if: ${cond}\`; main and pull requests must run the same jobs`);
  }
});

test("a ci-result job needs every other ci.yml job, so one required check covers them all", () => {
  const result = ciJobs.get(RESULT_JOB);
  assert.ok(result, `ci.yml has a ${RESULT_JOB} job`);
  const others = [...ciJobs.keys()].filter((id) => id !== RESULT_JOB).sort();
  assert.deepEqual(needsOf(result).sort(), others, `${RESULT_JOB} must need exactly every other job`);
  assert.ok(needsOf(result).includes("image"), `${RESULT_JOB} needs image`);
  assert.equal(jobKey(result, "if"), "always()", `${RESULT_JOB} must report even when a needed job fails`);
  assert.match(result, /RESULTS:\s*\$\{\{\s*join\(needs\.\*\.result, ' '\)\s*\}\}/, `${RESULT_JOB} reads every needed job's result`);
  assert.doesNotMatch(jobKey(result, "runs-on") ?? "", /self-hosted/);
});

test("ci-result passes only when every needed job succeeded", () => {
  const script = runScript(ciJobs.get(RESULT_JOB)!);
  const run = (results: string) =>
    spawnSync("bash", ["-eo", "pipefail", "-c", script], { env: { PATH: process.env.PATH, RESULTS: results }, encoding: "utf8" });
  assert.equal(run("success success").status, 0, "all needed jobs green: result green");
  for (const results of ["failure success", "success cancelled", "success skipped", ""]) {
    const r = run(results);
    assert.notEqual(r.status, 0, `results "${results}" must fail the gate`);
  }
});

test("the enforcement map names ci-result as the required, strict status check on main", () => {
  const doc = readFileSync(resolve(repoRoot, "docs", "EXTERNAL-REVIEW.md"), "utf8");
  const row = doc.split("\n").find((l) => l.startsWith("|") && l.includes(`\`${RESULT_JOB}\``));
  assert.ok(row, `docs/EXTERNAL-REVIEW.md enforcement map has a row for \`${RESULT_JOB}\``);
  assert.match(row, /required status check/i);
  assert.match(row, /strict/i);
});
