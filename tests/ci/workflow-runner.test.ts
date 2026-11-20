// The local workflow runner (tests/ci/workflow-runner.ts) evaluates the
// status-check functions and the needs context the way GitHub Actions does,
// for the parts ci.yml uses: its ci-result gate job runs `if: always()` and
// reads `${{ join(needs.*.result, ' ') }}` (red main 44693705253, where the
// runner rejected `always()`).
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, runEvent, type JobRun } from "./workflow-runner.ts";

function gateWorkflow(testExit: number): string {
  return `name: gate
on:
  push:
    branches: [main]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: exit ${testExit}
  image:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - run: echo built
  on-failure:
    if: failure()
    needs: [test, image]
    runs-on: ubuntu-latest
    steps:
      - run: echo reporting failure
  ci-result:
    if: always()
    needs: [test, image]
    runs-on: ubuntu-latest
    steps:
      - name: results
        env:
          RESULTS: \${{ join(needs.*.result, ' ') }}
        run: |
          echo "results: \${RESULTS}"
          for r in \${RESULTS}; do [ "\${r}" = success ]; done
      - name: after a failed step
        if: always()
        run: echo cleanup
`;
}

async function run(t: TestContext, testExit: number): Promise<Map<string, JobRun>> {
  const dir = mkdtempSync(join(tmpdir(), "runner-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "gate.yml"), gateWorkflow(testExit));
  const jobs = await runEvent({
    workflowsDir: dir,
    event: { name: "push", ref: "refs/heads/main", sha: "0".repeat(40) },
    workspace: dir,
    repository: "noncelogic/corpus-ranker",
    hostEnv: { PATH: process.env.PATH ?? "", HOME: dir },
  });
  return new Map(jobs.map((j) => [j.job, j]));
}

test("an always() gate job runs after a failed need and sees every need's result", async (t) => {
  const jobs = await run(t, 1);
  assert.equal(jobs.get("test")!.status, "failure");
  assert.equal(jobs.get("image")!.status, "skipped", "a job without a status function is skipped when a need failed");
  assert.equal(jobs.get("on-failure")!.status, "success", "failure() runs when a need failed");
  const gate = jobs.get("ci-result")!;
  assert.equal(gate.status, "failure", "the gate fails when a need did not succeed");
  assert.match(gate.steps[0]!.output, /results: failure skipped/);
  assert.deepEqual(gate.steps.map((s) => s.status), ["failure", "success"], "a step with if: always() still runs after a failed step");
});

test("an always() gate job passes when every need succeeded", async (t) => {
  const jobs = await run(t, 0);
  assert.equal(jobs.get("image")!.status, "success");
  assert.equal(jobs.get("on-failure")!.status, "skipped", "failure() does not run when every need succeeded");
  const gate = jobs.get("ci-result")!;
  assert.equal(gate.status, "success", gate.steps.map((s) => s.output).join("\n"));
  assert.match(gate.steps[0]!.output, /results: success success/);
});

test("expressions outside the supported subset are still refused, never guessed", () => {
  const ctx = { event: { name: "push" as const, ref: "refs/heads/main", sha: "x" }, repository: "r", vars: {}, secrets: {} };
  assert.throws(() => evaluate("contains(github.ref, 'main')", ctx), /unsupported/);
  assert.throws(() => evaluate("(github.ref == 'x') && true", ctx), /unsupported/);
  assert.throws(() => evaluate("hashFiles('**/x')", ctx), /unsupported/);
});
