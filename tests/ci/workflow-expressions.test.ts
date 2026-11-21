// Regression lock for red main https://github.com/noncelogic/corpus-ranker/actions/runs/44693705253
// (fixed by #67, green again in run 44728990206).
//
// Culprit: 14095ff (#64, CR-PUBLISH-OIDC), the only commit in 2befed0..14095ff.
// Root cause: #64 added a second local workflow emulator, tests/ci/workflow-runner.ts,
// whose expression evaluator refused every parenthesis, and ran the whole of
// .github/workflows/ci.yml through it. ci.yml already gated merges with a
// `ci-result` job using `if: always()` and `${{ join(needs.*.result, ' ') }}`
// (added by #57, f3a6260, #64's base), so the emulator threw
// "unsupported expression: always()" and tests/ci/publish-workflow.test.ts
// failed. #67 taught the emulator the status functions and the needs context.
//
// Why pull requests did not stop it: the pull-request check did run and went
// red on #64's own head (run 44681494397: test and ci-result failed), but the
// pull request was merged anyway. main's branch protection does not enforce
// the ci-result check that devops/github/branch-protection.json declares (read
// back on 2026-11-20 via GET repos/noncelogic/corpus-ranker/branches/main:
// required_status_checks.contexts [] with enforcement_level "off"). That is a
// repository setting applied by the DevOps route (placement-defaults
// #credentials.repository_settings), not something a product test can change.
// What a test can do is fail fast and name the cause: the failure surfaced
// only as an assertion inside a publish-specific simulation. This test walks
// every expression in every workflow, on every event and status the emulator
// supports, so a workflow that uses an expression the emulator cannot
// evaluate fails here, in the pull-request `npm test`, in milliseconds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, readWorkflow, type WorkflowEvent } from "./workflow-runner.ts";

const workflowsDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".github", "workflows");
const SHA = "0".repeat(40);
const EVENTS: WorkflowEvent[] = [
  { name: "push", ref: "refs/heads/main", sha: SHA },
  { name: "pull_request", ref: "refs/pull/1/merge", sha: SHA },
  { name: "workflow_dispatch", ref: "refs/heads/main", sha: SHA, inputs: {} },
];
const STATUSES = [
  { success: true, failure: false },
  { success: false, failure: true },
];

type Node = unknown;

/** Every expression under `node`: whole `if:` values, and each `${{ }}` in any other string. */
function expressions(node: Node, key = ""): string[] {
  if (typeof node === "string") {
    if (key === "if") return [node];
    return [...node.matchAll(/\$\{\{([\s\S]*?)\}\}/g)].map((m) => m[1]!.trim());
  }
  if (Array.isArray(node)) return node.flatMap((n) => expressions(n));
  if (typeof node === "object" && node !== null) return Object.entries(node).flatMap(([k, v]) => expressions(v, k));
  return [];
}

const needsOf = (job: Record<string, unknown>): string[] =>
  job.needs === undefined || job.needs === null ? [] : Array.isArray(job.needs) ? job.needs.map(String) : [String(job.needs)];

const files = readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f)).sort();

for (const file of files) {
  test(`the local workflow runner can evaluate every expression in ${file}`, () => {
    const workflow = readWorkflow(resolve(workflowsDir, file));
    const { jobs, ...top } = workflow as Record<string, unknown>;
    assert.ok(typeof jobs === "object" && jobs !== null, `${file}: no jobs`);
    const scopes: { where: string; exprs: string[]; needs?: string[] }[] = [{ where: file, exprs: expressions(top) }];
    for (const [id, job] of Object.entries(jobs as Record<string, Record<string, unknown>>)) {
      scopes.push({ where: `${file} job ${id}`, exprs: expressions(job), needs: needsOf(job) });
    }
    let count = 0;
    for (const { where, exprs, needs } of scopes) {
      for (const expr of exprs) {
        for (const event of EVENTS) {
          for (const status of STATUSES) {
            const ctx = {
              event,
              repository: "noncelogic/corpus-ranker",
              vars: {},
              secrets: {},
              ...(needs ? { needs: Object.fromEntries(needs.map((n) => [n, status.success ? "success" : "failure"])), status } : {}),
            };
            assert.doesNotThrow(() => evaluate(expr, ctx), `${where}: \`${expr}\` (${event.name}) is not evaluable by tests/ci/workflow-runner.ts`);
          }
        }
        count++;
      }
    }
    assert.ok(count > 0, `${file}: found no expressions to check`);
  });
}

test("the expression walk covers ci.yml's ci-result gate (the expressions behind red main 44693705253)", () => {
  const ci = readWorkflow(resolve(workflowsDir, "ci.yml")) as { jobs: Record<string, Node> };
  const found = expressions(ci.jobs["ci-result"]);
  assert.ok(found.includes("always()"), found.join(", "));
  assert.ok(found.some((e) => /^join\(\s*needs\.\*\.result/.test(e)), found.join(", "));
});
