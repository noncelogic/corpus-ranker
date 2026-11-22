// CR-GATE-CI-RESULT acceptance (policy main-stays-green v1): ci-result is the
// one pull-request result job over every job main runs.
//
// The guard (tests/ci/ci-result-gate.ts) reads .github/workflows/ci.yml's
// structured fields only -- `on:`, the jobs declared under `jobs:`, and each
// job's `if:` and `needs:` -- and refuses the workflow when ci-result does not
// run on pull requests and pushes to main, can be skipped by a failed needed
// job (GitHub reads a skipped required check as passing), or does not need a
// job that runs on push to main. Job names in comments, step names or run
// scripts are never counted. Other workflow files are outside its scope.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseYamlDocs, repoRoot, type Yaml } from "../deploy/render.ts";
import { CI_WORKFLOW, checkCiResultGate, checkRepoCiResultGate, RESULT_JOB, type Workflow } from "./ci-result-gate.ts";

const ciYmlText = readFileSync(resolve(repoRoot, CI_WORKFLOW), "utf8");
const parse = (text: string): Workflow => parseYamlDocs(text)[0] as Workflow;
/** A fresh copy of the repository's ci.yml to mutate. */
const ciYml = (): Workflow => parse(ciYmlText);
type Job = { [key: string]: Yaml };
const jobs = (w: Workflow) => w.jobs as { [id: string]: Job };
const resultJob = (w: Workflow) => jobs(w)[RESULT_JOB]!;
const pushJob = (extra: Job = {}): Job => ({ "runs-on": "ubuntu-latest", steps: [{ run: "true" }], ...extra });

function assertRefused(w: Workflow, pattern: RegExp, why: string) {
  const refusals = checkCiResultGate(w);
  assert.ok(refusals.some((r) => pattern.test(r)), `${why}: expected a refusal matching ${pattern}; got ${JSON.stringify(refusals)}`);
}
const assertAllowed = (w: Workflow, why: string) => assert.deepEqual(checkCiResultGate(w), [], why);

test("ci-result runs on pull_request and needs every job that runs on push to main", () => {
  const w = ciYml();
  assertAllowed(w, "the repository's ci.yml passes the gate");
  const needs = resultJob(w).needs as string[];
  assert.ok(needs.includes("test"), "ci-result needs test");
  // The image dry run: the job declaring DRY_RUN_OF (publish.yml's image build).
  const dryRun = Object.entries(jobs(w)).filter(([, j]) => (j.env as Job | undefined)?.DRY_RUN_OF !== undefined).map(([id]) => id);
  assert.deepEqual(dryRun, ["image"], "ci.yml declares the image dry-run job");
  assert.ok(needs.includes("image"), "ci-result needs the image dry run");
  assert.equal(resultJob(w).if, "always()", "ci-result reports even when a needed job fails");
  assert.deepEqual(checkRepoCiResultGate(repoRoot), [], "the repository check reads ci.yml and passes");
});

test("a workflow with a push-to-main job that ci-result does not need is refused, naming that job", () => {
  // A new job with no job-level if.
  const added = ciYml();
  jobs(added).audit = pushJob();
  assertRefused(added, /`audit`.*not in ci-result's needs/, "ungated push job");

  // An if that admits push.
  const admits = ciYml();
  jobs(admits).audit = pushJob({ if: "github.event_name == 'push' && github.ref == 'refs/heads/main'" });
  assertRefused(admits, /`audit`/, "push-only job");
  const either = ciYml();
  jobs(either).audit = pushJob({ if: "github.event_name != 'schedule'" });
  assertRefused(either, /`audit`/, "job whose if admits push");

  // A job gated on its needs' results runs on main when they succeed.
  const dependent = ciYml();
  jobs(dependent).audit = pushJob({ needs: "test", if: "needs.test.result == 'success'" });
  assertRefused(dependent, /`audit`.*not in ci-result's needs/, "job gated on needs.test.result");
  const onFailure = ciYml();
  jobs(onFailure).audit = pushJob({ needs: ["test"], if: "${{ always() && needs.test.result == 'failure' }}" });
  assertRefused(onFailure, /`audit`/, "job that runs when a need fails");
  // Values not known before the run are not read as null.
  const outputs = ciYml();
  jobs(outputs).audit = pushJob({ needs: "test", if: "needs.test.outputs.changed == 'true'" });
  assertRefused(outputs, /`audit`/, "job gated on a need's output");
  const undeclared = ciYml();
  jobs(undeclared).audit = pushJob({ if: "needs.test.result == 'success'" });
  assertRefused(undeclared, /`audit`/, "job reading a need it does not declare");
  const unknownField = ciYml();
  jobs(unknownField).audit = pushJob({ if: "github.actor == 'release-bot'" });
  assertRefused(unknownField, /`audit`/, "job gated on a github field not known before the run");
  // A need-gated job main never runs is still allowed.
  const prOnly = ciYml();
  jobs(prOnly).preview = pushJob({ needs: "test", if: "github.event_name == 'pull_request' && needs.test.result == 'success'" });
  assertAllowed(prOnly, "pull_request-only job gated on its needs");

  // The image dry run dropped from needs.
  const noImage = ciYml();
  resultJob(noImage).needs = ["test"];
  assertRefused(noImage, /`image`.*not in ci-result's needs/, "image dry run not needed");

  // Only the missing job is named.
  const refusals = checkCiResultGate(noImage);
  assert.ok(!refusals.some((r) => r.includes("`test`")), `test is needed and not named: ${JSON.stringify(refusals)}`);
});

test("ci.yml without a pull_request trigger is refused", () => {
  const w = ciYml();
  delete (w.on as Job).pull_request;
  assertRefused(w, /pull_request/, "no pull_request trigger");
});

test("ci-result with an if that excludes pull_request events is refused", () => {
  for (const cond of ["github.event_name == 'push'", "always() && github.event_name == 'push'", "${{ github.event_name != 'pull_request' }}"]) {
    const w = ciYml();
    resultJob(w).if = cond;
    assertRefused(w, /ci-result.*pull_request/, `if: ${cond}`);
  }
});

test("ci-result without if: always() or !cancelled() is refused (skipped reads as passing)", () => {
  const none = ciYml();
  delete resultJob(none).if;
  assertRefused(none, /ci-result.*skipped/, "no job-level if");
  const success = ciYml();
  resultJob(success).if = "success()";
  assertRefused(success, /ci-result.*skipped/, "if: success()");

  const notCancelled = ciYml();
  resultJob(notCancelled).if = "${{ !cancelled() }}";
  assertAllowed(notCancelled, "if: !cancelled() reports on a failed need");
});

test("ci.yml without a ci-result job is refused", () => {
  const w = ciYml();
  delete jobs(w)[RESULT_JOB];
  assertRefused(w, /no `ci-result` job/, "ci-result removed");
});

test("jobs main never runs need not be needed by ci-result", () => {
  const w = ciYml();
  jobs(w).preview = pushJob({ if: "github.event_name == 'pull_request'" });
  jobs(w).nightly = pushJob({ if: "github.event_name == 'schedule'" });
  jobs(w).manual = pushJob({ if: "${{ github.event_name == 'workflow_dispatch' }}" });
  jobs(w).either = pushJob({ if: "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'" });
  assertAllowed(w, "pull_request-, schedule- and workflow_dispatch-only jobs");
});

test("a pull_request-only job with more needs than are enumerated is still not counted as running on main", () => {
  // Seven needs is above the enumeration cutoff; the event exclusion is honoured first.
  const needs = ["n1", "n2", "n3", "n4", "n5", "n6", "n7"];
  for (const cond of ["github.event_name == 'pull_request'", "${{ always() && github.event_name == 'pull_request' }}"]) {
    const w = ciYml();
    for (const n of needs) jobs(w)[n] = pushJob({ if: "github.event_name == 'pull_request'" });
    jobs(w).preview = pushJob({ needs, if: cond });
    assertAllowed(w, `seven-need pull_request-only preview job (if: ${cond})`);
  }
  // The same seven-need job with an if that admits push is still refused.
  const pushToo = ciYml();
  for (const n of needs) jobs(pushToo)[n] = pushJob({ if: "github.event_name == 'pull_request'" });
  jobs(pushToo).preview = pushJob({ needs, if: "github.event_name != 'schedule'" });
  assertRefused(pushToo, /`preview`.*not in ci-result's needs/, "seven-need job whose if admits push");
});

test("an if that enumerates needs (needs.*) is not taken as excluding push to main", () => {
  // `audit` runs on main whenever `test` succeeds; the exclusion probe must not
  // read needs.* as an empty list and conclude the job never runs.
  for (const cond of ["contains(needs.*.result, 'success')", "${{ always() && contains(needs.*.result, 'success') }}"]) {
    const w = ciYml();
    jobs(w).audit = pushJob({ needs: "test", if: cond });
    assertRefused(w, /`audit`.*not in ci-result's needs/, `unneeded audit job with if: ${cond}`);
  }
});

test("ci-result does not list itself, and the gate does not ask it to", () => {
  const w = ciYml();
  assert.ok(!(resultJob(w).needs as string[]).includes(RESULT_JOB));
  assertAllowed(w, "ci-result is not required to need itself");
  // A single-string needs is read too.
  const single = ciYml();
  delete jobs(single).image;
  resultJob(single).needs = "test";
  assertAllowed(single, "needs: test as a string");
});

test("job names in comments, step names or run scripts are not counted as jobs", () => {
  const text = ciYmlText
    .replace(
      "  test:\n",
      "  # deploy: a job that would run on main if it were declared\n  test:\n",
    )
    .replace(
      "      - run: npm test\n",
      "      - run: npm test\n      - name: deploy and audit jobs are mentioned here only\n        run: echo 'jobs: deploy: runs-on: main'\n",
    );
  assert.notEqual(text, ciYmlText, "fixture edits applied");
  const w = parse(text);
  assert.deepEqual(Object.keys(jobs(w)).sort(), ["ci-result", "image", "test"]);
  assertAllowed(w, "mentions are not jobs");
});

test("workflow files other than ci.yml are outside the guard's scope", () => {
  const root = mkdtempSync(join(tmpdir(), "ci-result-gate-"));
  try {
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(join(root, CI_WORKFLOW), ciYmlText);
    writeFileSync(
      join(root, ".github", "workflows", "other.yml"),
      "name: other\non:\n  push:\n    branches: [main]\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n",
    );
    assert.deepEqual(checkRepoCiResultGate(root), [], "other.yml's push-to-main job is not ci.yml's business");

    // ...but the ci.yml the repository check reads is the one in that root.
    writeFileSync(join(root, CI_WORKFLOW), `${ciYmlText}\n  audit:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n`);
    assert.ok(checkRepoCiResultGate(root).some((r) => r.includes("`audit`")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
