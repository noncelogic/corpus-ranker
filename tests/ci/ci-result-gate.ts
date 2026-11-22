// The ci-result gate (CR-GATE-CI-RESULT; policy main-stays-green v1).
//
// ci-result is the one required pull-request check on main
// (devops/github/branch-protection.json), so it must prove every job main
// runs from .github/workflows/ci.yml. checkCiResultGate(workflow) returns the
// reasons a parsed ci.yml breaks that (empty when it holds):
//
//   - ci.yml is not selected for pull requests to main or pushes to main;
//   - there is no `ci-result` job;
//   - ci-result's job-level `if` excludes pull_request or push events, or does
//     not run it when a needed job failed (no always() / !cancelled()): a
//     skipped required check reads as passing;
//   - a job that runs on push to main (no job-level `if`, or one that admits a
//     push to main under any outcome of its needs) is absent from ci-result's
//     `needs`; each such job is named.
//
// It decides from structured fields only: `on:`, the job ids declared under
// `jobs:`, and each job's `if:` and `needs:`. Comments, step names and run
// scripts are never read. Job `if:` expressions are evaluated with the
// workflow emulator's evaluator (tests/deploy/workflow-runner.ts) under every
// combination of results of the job's needs (success, failure, cancelled,
// skipped); one it cannot evaluate, or one that reads a value not known before
// the run (a need's outputs, an undeclared need, an unmodelled github field),
// is treated as admitting push, so it must be needed.
// checkRepoCiResultGate(root) applies it to <root>/.github/workflows/ci.yml;
// other workflow files are out of scope.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseYamlDocs, type Yaml } from "../deploy/render.ts";
import { evaluate, triggers, type Result, type WorkflowEvent } from "../deploy/workflow-runner.ts";

export type Workflow = { [key: string]: Yaml };
type Obj = { [key: string]: Yaml };

export const RESULT_JOB = "ci-result";
export const CI_WORKFLOW = ".github/workflows/ci.yml";

const PUSH_MAIN: WorkflowEvent = { name: "push", ref: "refs/heads/main" };
const PULL_REQUEST: WorkflowEvent = { name: "pull_request", ref: "refs/pull/1/merge", baseRef: "main" };

const isObj = (v: Yaml | undefined): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A context object whose unlisted properties are unknown, not null: reading
 * one throws, so the caller treats the expression as not evaluable.
 */
function known<T extends object>(what: string, values: T): T {
  return new Proxy(values, {
    get(target, key, receiver) {
      if (typeof key === "symbol" || key === "toJSON" || Object.hasOwn(target, key)) return Reflect.get(target, key, receiver);
      throw new Error(`${what}.${key} is not known before the run`);
    },
  });
}

const githubContext = (event: WorkflowEvent) =>
  known("github", {
    event_name: event.name,
    ref: event.ref,
    base_ref: event.baseRef ?? "",
    head_ref: event.name === "pull_request" ? "feature" : "",
    ref_name: event.ref.replace(/^refs\/(heads|tags)\//, ""),
  });

const RESULTS = ["success", "failure", "cancelled", "skipped"] as const satisfies readonly Result[];
/** Above this many needs the outcomes are not enumerated; the job is assumed to run. */
const MAX_ENUMERATED_NEEDS = 6;

/** The `needs` context for these results; outputs (and undeclared needs) are unknown. */
const needsContext = (results: Record<string, Result>) => {
  const ctx: Record<string, { result: Result; outputs: Record<string, never> }> = {};
  for (const [id, result] of Object.entries(results)) {
    ctx[id] = known(`needs.${id}`, {
      result,
      outputs: new Proxy({} as Record<string, never>, {
        get(_t, key) {
          if (typeof key === "symbol") return undefined;
          throw new Error(`needs.${id}.outputs.${key} is not known before the run`);
        },
        ownKeys() {
          throw new Error(`needs.${id}.outputs is not known before the run`);
        },
      }),
    });
  }
  return known("needs", ctx);
};

/**
 * Whether a job-level `if` runs the job for this event when its needs ended
 * with `results`. As in GitHub (and the workflow runner), an `if` with no
 * status function is wrapped in success() and a needed job that did not
 * succeed stops it. Throws when the expression cannot be evaluated, including
 * when it reads a context value not known before the run.
 */
function admits(raw: Yaml | undefined, event: WorkflowEvent, results: Record<string, Result>): boolean {
  const outcomes = Object.values(results);
  const status = { failed: outcomes.includes("failure"), cancelled: outcomes.includes("cancelled") };
  const green = outcomes.every((r) => r === "success");
  if (raw === undefined || raw === null) return green;
  if (typeof raw === "boolean") return raw && green;
  if (typeof raw !== "string") throw new Error(`unsupported if: ${JSON.stringify(raw)}`);
  const src = raw.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1").trim();
  const { value, usesStatus } = evaluate(src, { github: githubContext(event), needs: needsContext(results), status });
  const truthy = !(value === false || value === null || value === 0 || value === "");
  return usesStatus ? truthy : truthy && green;
}

/** Every assignment of a result to each of these needs. */
function* assignments(needs: string[]): Generator<Record<string, Result>> {
  if (needs.length === 0) {
    yield {};
    return;
  }
  const [first, ...rest] = needs;
  for (const tail of assignments(rest)) for (const r of RESULTS) yield { [first!]: r, ...tail };
}

/** Whether main runs this job on a push, under any outcome of its needs. */
function runsOnPushToMain(job: Obj): boolean {
  const needs = needsOf(job);
  if (needs.length > MAX_ENUMERATED_NEEDS) return true; // Too many outcomes to check: assume it runs, so ci-result must need it.
  try {
    for (const results of assignments(needs)) if (admits(job.if, PUSH_MAIN, results)) return true;
    return false;
  } catch {
    return true; // Not evaluable (or reads an unknown value): assume it can run on main, so ci-result must need it.
  }
}

const needsOf = (job: Obj): string[] => {
  const n = job.needs;
  if (n === undefined || n === null) return [];
  return (Array.isArray(n) ? n : [n]).filter((x): x is string => typeof x === "string");
};

function selected(workflow: Workflow, event: WorkflowEvent): boolean | string {
  try {
    return triggers(workflow, event);
  } catch (e) {
    return (e as Error).message;
  }
}

export function checkCiResultGate(workflow: Workflow): string[] {
  const refusals: string[] = [];

  const pr = selected(workflow, PULL_REQUEST);
  if (pr !== true) {
    refusals.push(`ci.yml is not run on pull_request to main${typeof pr === "string" ? ` (${pr})` : ""}: ci-result cannot report on pull requests`);
  }
  const push = selected(workflow, PUSH_MAIN);
  if (push !== true) {
    refusals.push(`ci.yml is not run on push to main${typeof push === "string" ? ` (${push})` : ""}`);
  }

  const jobs = isObj(workflow.jobs) ? workflow.jobs : {};
  const result = jobs[RESULT_JOB];
  if (!isObj(result)) {
    refusals.push(`ci.yml has no \`${RESULT_JOB}\` job: no single check proves what main runs`);
    return refusals;
  }

  // ci-result's needs all succeeded, or one of them failed.
  const resultNeeds = needsOf(result);
  const outcome = (o: "success" | "failure"): Record<string, Result> =>
    Object.fromEntries(resultNeeds.map((n, i) => [n, o === "failure" && i === 0 ? "failure" : "success"]));
  const check = (event: WorkflowEvent, o: "success" | "failure"): boolean | string => {
    try {
      return admits(result.if, event, outcome(o));
    } catch (e) {
      return (e as Error).message;
    }
  };
  for (const event of [PULL_REQUEST, PUSH_MAIN]) {
    const green = check(event, "success");
    if (green !== true) {
      refusals.push(`${RESULT_JOB}'s if (${JSON.stringify(result.if ?? null)}) excludes ${event.name} events${typeof green === "string" ? ` (${green})` : ""}`);
      continue;
    }
    if (check(event, "failure") !== true) {
      refusals.push(
        `${RESULT_JOB} is skipped on ${event.name} when a needed job fails (its if is ${JSON.stringify(result.if ?? null)}, not always() or !cancelled()); a skipped required check reads as passing`,
      );
    }
  }

  const needed = new Set(needsOf(result));
  for (const [id, job] of Object.entries(jobs)) {
    if (id === RESULT_JOB || !isObj(job)) continue;
    if (runsOnPushToMain(job) && !needed.has(id)) {
      refusals.push(`job \`${id}\` runs on push to main but is not in ${RESULT_JOB}'s needs`);
    }
  }
  return refusals;
}

/** The gate over <root>/.github/workflows/ci.yml (and no other workflow file). */
export function checkRepoCiResultGate(root: string): string[] {
  const docs = parseYamlDocs(readFileSync(resolve(root, CI_WORKFLOW), "utf8"));
  if (docs.length !== 1 || !isObj(docs[0])) return [`${CI_WORKFLOW}: expected one YAML mapping`];
  return checkCiResultGate(docs[0]);
}
