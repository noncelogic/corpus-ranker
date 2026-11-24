// CR-GATE-PR-CHECKS acceptance (policy main-stays-green v2): every check the
// estate declaration requires on corpus-ranker main reports on every pull
// request to main.
//
// The estate declaration (meta-harness devops/github/branch-protection/
// corpus-ranker.json) requires the checks test, image and ci-result, strict.
// A required check that never reports on a pull request blocks every merge;
// one that reports only on push to main proves nothing before the merge. So
// each of the three jobs in .github/workflows/ci.yml must run on a pull
// request to main.
//
// The workflow is not grepped: tests/deploy/workflow-runner.ts runs the
// complete ci.yml -- event selection, `needs` scheduling, job `if` conditions
// and every `run` step under bash -- for a pull request to main, with
// stand-in `npm`, `kustomize` and `docker` that record their calls. A
// required check reports when its job ran (it is not skipped and ci.yml was
// selected for the event). The later tests take the repository's ci.yml,
// take one required job off the pull-request path in each way the workflow
// can (event selection, a job `if`, a renamed or removed job, a need that is
// pushed-only) and require the same check to refuse it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repoRoot, type Yaml } from "../deploy/render.ts";
import { loadWorkflow, runWorkflow, type Run, type WorkflowEvent } from "../deploy/workflow-runner.ts";
import { loadDeclared } from "../../deploy/github/check-branch-protection.ts";

/** The checks the estate declaration requires on corpus-ranker main (meta-harness devops/github/branch-protection/corpus-ranker.json). */
const REQUIRED_CHECKS = ["test", "image", "ci-result"] as const;

type Obj = { [key: string]: Yaml };
const CI_YML = resolve(repoRoot, ".github", "workflows", "ci.yml");
/** A fresh copy of the repository's ci.yml to mutate. */
const ciYml = (): Obj => loadWorkflow(CI_YML);
const jobsOf = (w: Obj) => w.jobs as { [id: string]: Obj };

const PULL_REQUEST: WorkflowEvent = { name: "pull_request", ref: "refs/pull/91/merge", baseRef: "main" };

const work = mkdtempSync(join(tmpdir(), "required-checks-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));
const binDir = join(work, "bin");
const callLog = join(work, "calls.log");
const dockerState = join(work, "docker-state");
mkdirSync(binDir);
mkdirSync(dockerState);
// Stand-ins for the tools ci.yml's steps call: record the call and succeed.
// docker also keeps image state, so the image job's manifest and label check
// (.github/scripts/image-build.sh image_verify) reads what was built.
const fakeDocker = resolve(repoRoot, "tests", "ci", "fake-docker.sh");
for (const tool of ["npm", "kustomize", "docker"]) {
  const body = `#!/bin/bash\necho "\${GITHUB_JOB} \${0##*/} $*" >> "$CALL_LOG"\n` + (tool === "docker" ? `. "${fakeDocker}" "$@"\n` : "");
  writeFileSync(join(binDir, tool), body);
  chmodSync(join(binDir, tool), 0o755);
}
// What the Actions runner sets and the image build definition labels the image with.
const ACTIONS_ENV = { GITHUB_REPOSITORY: "noncelogic/corpus-ranker", GITHUB_SHA: "43ef1b8b944d363f4f5b700d6365eaa741a2b074" };

function runPullRequest(workflow: Obj): { run: Run; calls: string[] } {
  writeFileSync(callLog, "");
  const run = runWorkflow(workflow, { event: PULL_REQUEST, binDir, cwd: repoRoot, env: { CALL_LOG: callLog, DOCKER_STATE: dockerState, ...ACTIONS_ENV } });
  return { run, calls: readFileSync(callLog, "utf8").split("\n").filter(Boolean) };
}

/**
 * The required checks a pull request to main would not report for this
 * workflow, each with the reason; empty when every one reports.
 */
function unreportedRequiredChecks(workflow: Obj): string[] {
  const { run } = runPullRequest(workflow);
  if (!run.triggered) return REQUIRED_CHECKS.map((c) => `${c}: ci.yml is not run on pull_request to main`);
  const out: string[] = [];
  for (const check of REQUIRED_CHECKS) {
    const job = run.jobs.find((j) => j.checkName === check);
    if (!job) out.push(`${check}: no ci.yml job reports this check`);
    else if (job.result === "skipped") out.push(`${check}: job ${job.id} is skipped on pull_request to main`);
  }
  return out;
}

function assertUnreported(workflow: Obj, check: string, why: string) {
  const missing = unreportedRequiredChecks(workflow);
  assert.ok(missing.some((m) => m.startsWith(`${check}: `)), `${why}: expected ${check} to be refused; got ${JSON.stringify(missing)}`);
}

test("ci.yml: test, image and ci-result each run on pull_request to main", () => {
  assert.deepEqual(unreportedRequiredChecks(ciYml()), [], "every required check reports on a pull request to main");
  const { run, calls } = runPullRequest(ciYml());
  const results = Object.fromEntries(run.jobs.map((j) => [j.checkName, j.result]));
  for (const check of REQUIRED_CHECKS) assert.equal(results[check], "success", `${check} runs and passes on a green pull request`);
  // The jobs do their work on the pull request, not an empty pass.
  assert.ok(calls.includes("test npm test"), `test runs the suite on the pull request; calls: ${calls.join(" | ")}`);
  assert.ok(calls.some((c) => /^image docker build .* -t corpus-ranker:ci \.$/.test(c)), `image builds the image; calls: ${calls.join(" | ")}`);
});

test("the repository's declared required checks are among the checks held to report on pull requests", () => {
  const declared = loadDeclared();
  assert.equal(declared.branch, "main");
  for (const context of declared.required_status_checks.contexts) {
    assert.ok((REQUIRED_CHECKS as readonly string[]).includes(context), `declared required check ${context} is held to report on pull requests`);
  }
});

test("the check fails when ci.yml is no longer selected for pull requests to main", () => {
  const dropped = ciYml();
  delete (dropped.on as Obj).pull_request;
  for (const check of REQUIRED_CHECKS) assertUnreported(dropped, check, "on: without pull_request");

  const otherBase = ciYml();
  (otherBase.on as Obj).pull_request = { branches: ["release"] };
  for (const check of REQUIRED_CHECKS) assertUnreported(otherBase, check, "pull_request filtered to another base branch");
});

for (const check of REQUIRED_CHECKS) {
  test(`the check fails when ${check} is removed from the pull_request path`, () => {
    // A job-level if that runs the job only on push.
    const pushOnly = ciYml();
    jobsOf(pushOnly)[check]!.if = "github.event_name == 'push'";
    assertUnreported(pushOnly, check, `${check} with if: push only`);

    // The job taken out of the workflow (and out of its dependants' needs).
    const removed = ciYml();
    delete jobsOf(removed)[check];
    for (const job of Object.values(jobsOf(removed))) {
      if (Array.isArray(job.needs)) job.needs = job.needs.filter((n) => n !== check);
      else if (job.needs === check) delete job.needs;
    }
    assertUnreported(removed, check, `${check} removed from ci.yml`);

    // The job reporting under another check name.
    const renamed = ciYml();
    jobsOf(renamed)[check]!.name = `${check} (renamed)`;
    assertUnreported(renamed, check, `${check} reporting as another check name`);
  });
}

test("the check fails when a job a required check needs is skipped on pull requests", () => {
  // image needs test: a push-only test skips image too (its if defaults to success()).
  const w = ciYml();
  jobsOf(w).test!.if = "github.event_name == 'push'";
  assertUnreported(w, "image", "image needs a push-only test");
});
