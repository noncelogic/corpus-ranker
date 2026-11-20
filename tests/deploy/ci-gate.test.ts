// COND-218 acceptance (policy main-stays-green v1): every job main runs from
// .github/workflows/ci.yml is proven on the pull request first, behind a
// required, strict pull-request check.
//
// The workflow is not grepped: tests/deploy/workflow-runner.ts runs the
// complete ci.yml -- event selection, `needs` scheduling, job and step `if`
// conditions, `${{ }}` expressions and every `run` step under bash -- for a
// controlled event, with stand-in `npm`, `kustomize` and `docker` that record
// their calls and fail for the jobs a test names. So:
//
// - ci.yml is selected for pull requests and pushes to main, not for other
//   branches' pushes nor pull_request_target;
// - for every combination of job outcomes, main runs exactly the jobs the
//   pull request runs, with the same results, `image` (the pull-request dry
//   run of publish.yml's build, `docker build`) among them;
// - `ci-result` reports on every outcome and succeeds only when every other
//   job succeeded;
// - the required checks declared in devops/github/branch-protection.json
//   (strict) are checks the pull-request run reports, and failing any job
//   main runs makes one of them fail (not skip: GitHub counts a skipped
//   required check as passing).
//
// Branch protection itself is GitHub state: deploy/github/check-branch-protection.ts
// reads it back through the GitHub API and compares it with the declared
// file. The last tests run that checker against a stand-in `gh` serving the
// API's response shapes, including the one main returns today (no required
// checks), which it must report as drift.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { repoRoot } from "./render.ts";
import { loadWorkflow, runWorkflow, type Run, type WorkflowEvent } from "./workflow-runner.ts";
import { loadDeclared } from "../../deploy/github/check-branch-protection.ts";

const RESULT_JOB = "ci-result";
const workflow = loadWorkflow(resolve(repoRoot, ".github", "workflows", "ci.yml"));

const PULL_REQUEST: WorkflowEvent = { name: "pull_request", ref: "refs/pull/57/merge", baseRef: "main" };
const PUSH_MAIN: WorkflowEvent = { name: "push", ref: "refs/heads/main" };

const work = mkdtempSync(join(tmpdir(), "ci-gate-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));
const binDir = join(work, "bin");
const callLog = join(work, "calls.log");

// Stand-ins for the tools ci.yml's steps call: record the call, fail when the
// running job is listed in FAIL_JOBS. Only builtins, so PATH can be just bin/.
const STAND_IN = `#!/bin/bash
echo "\${GITHUB_JOB} \${0##*/} $*" >> "$CALL_LOG"
for job in $FAIL_JOBS; do
  if [ "$job" = "$GITHUB_JOB" ]; then
    echo "stand-in \${0##*/} failed in job $GITHUB_JOB" >&2
    exit 1
  fi
done
`;
mkdirSync(binDir);
for (const tool of ["npm", "kustomize", "docker"]) {
  writeFileSync(join(binDir, tool), STAND_IN);
  chmodSync(join(binDir, tool), 0o755);
}

function runCi(event: WorkflowEvent, failJobs: string[] = []): { run: Run; calls: string[] } {
  writeFileSync(callLog, "");
  const run = runWorkflow(workflow, { event, binDir, cwd: repoRoot, env: { CALL_LOG: callLog, FAIL_JOBS: failJobs.join(" ") } });
  return { run, calls: readFileSync(callLog, "utf8").split("\n").filter(Boolean) };
}

const results = (run: Run): Record<string, string> => Object.fromEntries(run.jobs.map((j) => [j.id, j.result]));
const job = (run: Run, id: string) => {
  const j = run.jobs.find((x) => x.id === id);
  assert.ok(j, `ci.yml ran no job ${id}`);
  return j;
};

/** Every job of ci.yml other than the result job, from a green pull-request run. */
const gatedJobs = runCi(PULL_REQUEST).run.jobs.map((j) => j.id).filter((id) => id !== RESULT_JOB);

/** Every subset of the gated jobs, as the set of jobs made to fail. */
const failureCombos: string[][] = gatedJobs.reduce<string[][]>((acc, id) => acc.flatMap((s) => [s, [...s, id]]), [[]]);

test("ci.yml runs on pull requests and on pushes to main, not on other events", () => {
  for (const event of [PULL_REQUEST, PUSH_MAIN]) {
    const { run } = runCi(event);
    assert.ok(run.triggered, `ci.yml must run on ${event.name} ${event.ref}`);
    assert.deepEqual(results(run), { test: "success", image: "success", [RESULT_JOB]: "success" }, `${event.name}: all jobs green`);
  }
  assert.equal(runCi({ name: "push", ref: "refs/heads/feature" }).run.triggered, false, "pushes to other branches do not run ci.yml");
  assert.equal(
    runCi({ name: "pull_request_target", ref: "refs/heads/main", baseRef: "main" }).run.triggered,
    false,
    "ci.yml must never run on pull_request_target",
  );
});

test("every ci.yml job main runs also runs on the pull request, with the same outcome", () => {
  assert.ok(gatedJobs.includes("image"), "ci.yml keeps the image build job");
  for (const fail of failureCombos) {
    const main = runCi(PUSH_MAIN, fail);
    const pr = runCi(PULL_REQUEST, fail);
    assert.deepEqual(results(pr.run), results(main.run), `failing [${fail}]: main and the pull request run the same jobs to the same results`);
    assert.deepEqual(pr.calls, main.calls, `failing [${fail}]: main and the pull request run the same commands`);
  }
  // The pull request really runs the image build main runs.
  const { calls } = runCi(PULL_REQUEST);
  assert.ok(calls.includes("image docker build -t corpus-ranker:ci ."), `the image job builds the image on the pull request; calls: ${calls.join(" | ")}`);
});

test("ci-result reports on every outcome and passes only when every other job succeeded", () => {
  for (const fail of failureCombos) {
    const { run } = runCi(PULL_REQUEST, fail);
    const result = job(run, RESULT_JOB);
    const expected = fail.length === 0 ? "success" : "failure";
    assert.equal(result.result, expected, `failing [${fail}]: ${RESULT_JOB} ${expected}; jobs ${JSON.stringify(results(run))}`);
  }
  // A job skipped because its need failed is not a pass either.
  const { run } = runCi(PULL_REQUEST, ["test"]);
  assert.equal(job(run, "image").result, "skipped");
  assert.match(job(run, RESULT_JOB).steps.at(-1)!.stderr, /skipped/);
});

test("the declared required checks (strict) gate every job main runs on the pull request", () => {
  const declared = loadDeclared();
  assert.equal(declared.branch, "main");
  assert.equal(declared.required_status_checks.strict, true, "protection on main is strict (up to date with main)");
  const required = declared.required_status_checks.contexts;
  assert.ok(required.length > 0, "main requires at least one status check");

  const green = runCi(PULL_REQUEST).run;
  for (const name of required) {
    const check = green.jobs.find((j) => j.checkName === name);
    assert.ok(check, `required check ${name} is reported by the ci.yml pull-request run`);
    assert.equal(check.result, "success", `required check ${name} passes on a green pull request`);
  }

  const mainJobs = runCi(PUSH_MAIN).run.jobs.filter((j) => j.result !== "skipped").map((j) => j.id);
  assert.ok(mainJobs.includes("image"));
  for (const id of mainJobs.filter((j) => !required.includes(j))) {
    const { run } = runCi(PULL_REQUEST, [id]);
    const failing = run.jobs.filter((j) => required.includes(j.checkName) && j.result === "failure").map((j) => j.checkName);
    assert.ok(failing.length > 0, `failing ${id} on the pull request fails a required check; checks ${JSON.stringify(results(run))}`);
  }
});

// ---------------------------------------------------------------------------
// The protection readback checker, against a stand-in `gh`.

const checker = resolve(repoRoot, "deploy", "github", "check-branch-protection.ts");
const BRANCH_PATH = "repos/noncelogic/corpus-ranker/branches/main";
const RSC_PATH = `${BRANCH_PATH}/protection/required_status_checks`;

/** GET repos/{repo}/branches/main as GitHub returns it (commit and links trimmed). */
const branchRead = (rsc: object) =>
  JSON.stringify({ name: "main", commit: { sha: "85d4e3af1864123c6a62c7b246e2794a1daf5fac" }, protected: true, protection: { enabled: true, required_status_checks: rsc } });
/** GET .../protection/required_status_checks as GitHub returns it. */
const rscRead = (strict: boolean, contexts: string[]) =>
  JSON.stringify({
    url: `https://api.github.com/${RSC_PATH}`,
    strict,
    contexts,
    contexts_url: `https://api.github.com/${RSC_PATH}/contexts`,
    checks: contexts.map((context) => ({ context, app_id: 15368 })),
  });
const FORBIDDEN = '{"message":"Resource not accessible by integration","status":"403"}gh: Resource not accessible by integration (HTTP 403)';

function runChecker(responses: Record<string, { body?: string; error?: string }>) {
  const dir = mkdtempSync(join(work, "gh-"));
  const fixtures: string[] = [];
  for (const [path, r] of Object.entries(responses)) {
    const file = join(dir, path.replace(/\//g, "_"));
    if (r.body !== undefined) writeFileSync(`${file}.json`, r.body);
    if (r.error !== undefined) writeFileSync(`${file}.err`, r.error);
    fixtures.push(path);
  }
  // `gh api [-H ...] <path>`: serve <path> from the fixtures; unknown paths are 404.
  writeFileSync(
    join(dir, "gh"),
    `#!/bin/bash
[ "$1" = api ] || { echo "unexpected gh $*" >&2; exit 2; }
path="\${@: -1}"
f="${dir}/\${path//\\//_}"
if [ -f "$f.err" ]; then cat "$f.err" >&2; exit 1; fi
if [ -f "$f.json" ]; then cat "$f.json"; exit 0; fi
echo "gh: Not Found (HTTP 404) $path" >&2; exit 1
`,
  );
  chmodSync(join(dir, "gh"), 0o755);
  return spawnSync(process.execPath, [checker], {
    encoding: "utf8",
    env: { PATH: `${dir}:${dirname(process.execPath)}:/usr/bin:/bin` },
  });
}

test("the protection readback reports main's current protection (no required checks) as drift", () => {
  // What main returns today: protected, but no required status checks, and
  // the strict flag unreadable with a read-only token.
  const r = runChecker({
    [BRANCH_PATH]: { body: branchRead({ enforcement_level: "off", contexts: [], checks: [] }) },
    [RSC_PATH]: { error: FORBIDDEN },
  });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /status check "ci-result" is declared but not required/);
  assert.match(r.stderr, /not enforced \(enforcement_level "off"\)/);
  assert.match(r.stderr, /read failed: .*HTTP 403/);
});

test("the protection readback passes only on strict protection requiring exactly the declared checks", () => {
  const enforced = { body: branchRead({ enforcement_level: "everyone", contexts: ["ci-result"], checks: [{ context: "ci-result", app_id: 15368 }] }) };
  const ok = runChecker({ [BRANCH_PATH]: enforced, [RSC_PATH]: { body: rscRead(true, ["ci-result"]) } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /as declared/);

  const loose = runChecker({ [BRANCH_PATH]: enforced, [RSC_PATH]: { body: rscRead(false, ["ci-result"]) } });
  assert.equal(loose.status, 1);
  assert.match(loose.stderr, /strict is false, declared true/);

  const extra = runChecker({
    [BRANCH_PATH]: { body: branchRead({ enforcement_level: "everyone", contexts: ["ci-result", "test"], checks: [] }) },
    [RSC_PATH]: { body: rscRead(true, ["ci-result", "test"]) },
  });
  assert.equal(extra.status, 1);
  assert.match(extra.stderr, /status check "test" is required but not declared/);

  const unreadable = runChecker({ [BRANCH_PATH]: enforced, [RSC_PATH]: { error: FORBIDDEN } });
  assert.equal(unreadable.status, 2, "strict unreadable and nothing else differs: the check is inconclusive, not a pass");
  assert.match(unreadable.stderr, /read failed: .*HTTP 403/);
});
