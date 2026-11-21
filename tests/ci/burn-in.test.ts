// CR-BURN-IN acceptance (policy tests-burn-in-before-merge: in-test retries
// forbidden, scope added or changed tests only, a failure blocks the merge).
// .github/workflows/burn-in.yml is a workflow_dispatch workflow the conductor
// dispatches on a pull request head with the test files to prove and a repeat
// count N; it runs .github/scripts/burn-in.sh, which runs each named
// tests/**/*.test.ts file N times with `node --test --test-concurrency=1` (the
// package.json test command, one file at a time, no retries) and stops at the
// first failing run, naming the file and the run number.
//
// The script runs for real against fixture test files in a scratch workspace
// (one counts its runs, one fails on a chosen run). The workflow is run whole,
// as written, by the local runner (tests/ci/workflow-runner.ts) for a
// workflow_dispatch event, so its inputs reach the script only through env.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readWorkflow, runEvent, triggers, type WorkflowEvent } from "./workflow-runner.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = resolve(repoRoot, ".github", "scripts", "burn-in.sh");
const WORKFLOW = resolve(repoRoot, ".github", "workflows", "burn-in.yml");
const SHA = "f210873" + "0".repeat(33);

/** A fixture test that appends one line to <name>.runs each time it runs, and fails on run `failOn` (0: never). */
function fixture(name: string, failOn = 0): string {
  return `import { test } from "node:test";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
const log = new URL("./${name}.runs", import.meta.url);
test("${name}", () => {
  const run = (existsSync(log) ? readFileSync(log, "utf8").split("\\n").filter(Boolean).length : 0) + 1;
  appendFileSync(log, "run\\n");
  if (run === ${failOn}) throw new Error("${name} failed on run " + run);
});
`;
}

/** A scratch checkout: the burn-in script and fixture tests under tests/fixture/. */
function workspace(t: TestContext, tests: Record<string, number>): string {
  const dir = mkdtempSync(join(tmpdir(), "burn-in-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, ".github", "scripts"), { recursive: true });
  cpSync(SCRIPT, join(dir, ".github", "scripts", "burn-in.sh"));
  mkdirSync(join(dir, "tests", "fixture"), { recursive: true });
  for (const [name, failOn] of Object.entries(tests)) writeFileSync(join(dir, "tests", "fixture", `${name}.test.ts`), fixture(name, failOn));
  return dir;
}

const runs = (dir: string, name: string): number => {
  const log = join(dir, "tests", "fixture", `${name}.runs`);
  return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0;
};

function burnIn(dir: string, tests: string, repeat: string): { status: number | null; output: string } {
  const r = spawnSync("bash", [".github/scripts/burn-in.sh"], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", HOME: dir, TESTS: tests, REPEAT: repeat },
    encoding: "utf8",
  });
  return { status: r.status, output: `${r.stdout}${r.stderr}` };
}

test("burn-in runs every named test file the requested number of times and exits 0 when every run passes", (t) => {
  const dir = workspace(t, { alpha: 0, beta: 0, gamma: 0 });
  // Newline- and space-separated, as a dispatch input may carry either.
  const { status, output } = burnIn(dir, "tests/fixture/alpha.test.ts\ntests/fixture/beta.test.ts", "4");
  assert.equal(status, 0, output);
  assert.equal(runs(dir, "alpha"), 4, output);
  assert.equal(runs(dir, "beta"), 4, output);
  assert.equal(runs(dir, "gamma"), 0, "a file that was not named is not run");
  assert.match(output, /tests\/fixture\/alpha\.test\.ts: run 4 of 4 passed/);
  assert.match(output, /tests\/fixture\/beta\.test\.ts: run 4 of 4 passed/);

  const spaced = burnIn(dir, " tests/fixture/gamma.test.ts ", "2");
  assert.equal(spaced.status, 0, spaced.output);
  assert.equal(runs(dir, "gamma"), 2);
});

test("burn-in exits non-zero naming the file and run number when one of the repeated runs fails", (t) => {
  const dir = workspace(t, { steady: 0, flaky: 3, after: 0 });
  const { status, output } = burnIn(dir, "tests/fixture/steady.test.ts tests/fixture/flaky.test.ts tests/fixture/after.test.ts", "5");
  assert.notEqual(status, 0, output);
  assert.match(output, /burn-in: tests\/fixture\/flaky\.test\.ts failed on run 3 of 5/);
  assert.equal(runs(dir, "steady"), 5);
  assert.equal(runs(dir, "flaky"), 3, "the first failing run stops the burn-in: no retry, no further runs");
  assert.equal(runs(dir, "after"), 0, "files after the failure are not run");
});

test("burn-in refuses a path outside tests/, a non-test file, a missing file and a non-positive-integer repeat before running anything", (t) => {
  const dir = workspace(t, { ok: 0 });
  writeFileSync(join(dir, "tests", "fixture", "helper.ts"), "");
  const good = "tests/fixture/ok.test.ts";
  const refused: [string, string, RegExp][] = [
    [`${good} src/x.test.ts`, "2", /not a tests\/\*\*\/\*\.test\.ts file: src\/x\.test\.ts/],
    [`${good} tests/fixture/helper.ts`, "2", /not a tests\/\*\*\/\*\.test\.ts file: tests\/fixture\/helper\.ts/],
    [`${good} tests/../src/x.test.ts`, "2", /not a tests\/\*\*\/\*\.test\.ts file/],
    [`${good} /etc/x.test.ts`, "2", /not a tests\/\*\*\/\*\.test\.ts file/],
    [`${good} tests/fixture/missing.test.ts`, "2", /no such test file: tests\/fixture\/missing\.test\.ts/],
    [`${good} tests/fixture/$(touch pwned).test.ts`, "2", /not a tests\/\*\*\/\*\.test\.ts file/],
    ["", "2", /no test files named/],
    [good, "0", /repeat must be a positive integer/],
    [good, "-1", /repeat must be a positive integer/],
    [good, "2.5", /repeat must be a positive integer/],
    [good, "3; touch pwned", /repeat must be a positive integer/],
    [good, "", /repeat must be a positive integer/],
  ];
  for (const [tests, repeat, message] of refused) {
    const { status, output } = burnIn(dir, tests, repeat);
    assert.notEqual(status, 0, `${JSON.stringify(tests)} x ${JSON.stringify(repeat)} was accepted:\n${output}`);
    assert.match(output, message, output);
  }
  assert.equal(runs(dir, "ok"), 0, "nothing ran");
  assert.equal(existsSync(join(dir, "pwned")), false);
  assert.equal(existsSync(join(dir, "tests", "fixture", "pwned")), false);
});

test("burn-in.yml is dispatch-triggered with read-only permissions and hands the tests and repeat inputs to the script through env on the test job's runner", async (t) => {
  const workflow = readWorkflow(WORKFLOW);
  const on = workflow.on as Record<string, { inputs: Record<string, Record<string, unknown>> }>;
  assert.deepEqual(Object.keys(on), ["workflow_dispatch"], "dispatch only: never push, pull_request or pull_request_target");
  assert.deepEqual(Object.keys(on.workflow_dispatch.inputs).sort(), ["repeat", "tests"]);
  assert.equal(on.workflow_dispatch.inputs.tests!.required, true);
  assert.equal(on.workflow_dispatch.inputs.repeat!.required, true);
  assert.deepEqual(workflow.permissions, { "contents": "read" });

  const ci = readWorkflow(resolve(repoRoot, ".github", "workflows", "ci.yml")) as { jobs: Record<string, Record<string, unknown>> };
  const jobs = workflow.jobs as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(jobs), ["burn-in"]);
  const job = jobs["burn-in"]!;
  assert.deepEqual(job["runs-on"], ci.jobs.test!["runs-on"], "burn-in runs on the runner ci.yml's test job uses");
  assert.equal(job.permissions, undefined, "no job-level permissions widen the workflow's contents: read");

  const steps = job.steps as Record<string, unknown>[];
  const runSteps = steps.filter((s) => typeof s.run === "string");
  for (const s of runSteps) assert.doesNotMatch(String(s.run), /\$\{\{/, `a run script interpolates an expression: ${String(s.run)}`);
  const burn = runSteps.find((s) => /\.github\/scripts\/burn-in\.sh/.test(String(s.run)));
  assert.ok(burn, "a step runs .github/scripts/burn-in.sh");
  assert.deepEqual(burn.env, { TESTS: "${{ inputs.tests }}", REPEAT: "${{ inputs.repeat }}" });

  for (const name of ["push", "pull_request"] as const) {
    assert.equal(triggers(workflow, { name, ref: name === "push" ? "refs/heads/main" : "refs/pull/83/merge", sha: SHA }), false, `fires on ${name}`);
  }

  // Run it whole, as dispatched on a pull request head, with a stand-in npm
  // (npm ci) and the real script, against the fixtures.
  const dir = workspace(t, { alpha: 0, flaky: 2 });
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "npm"), `#!/bin/bash\necho "npm $*" >> "${join(dir, "npm.log")}"\n`);
  chmodSync(join(bin, "npm"), 0o755);
  const dispatch = async (inputs: Record<string, string>) => {
    const event: WorkflowEvent = { name: "workflow_dispatch", ref: "refs/heads/cond-307", sha: SHA, inputs };
    const [run] = await runEvent({
      workflowsDir: dirname(WORKFLOW),
      workflows: ["burn-in.yml"],
      event,
      workspace: dir,
      repository: "noncelogic/corpus-ranker",
      hostEnv: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: dir },
    });
    assert.ok(run, "burn-in.yml ran for workflow_dispatch");
    return run;
  };

  const passing = await dispatch({ tests: "tests/fixture/alpha.test.ts", repeat: "3" });
  assert.equal(passing.status, "success", passing.steps.map((s) => s.output).join("\n"));
  assert.equal(runs(dir, "alpha"), 3);
  assert.match(readFileSync(join(dir, "npm.log"), "utf8"), /^npm ci --ignore-scripts$/m);

  const failing = await dispatch({ tests: "tests/fixture/alpha.test.ts tests/fixture/flaky.test.ts", repeat: "4" });
  assert.equal(failing.status, "failure");
  assert.match(failing.steps.at(-1)!.output, /tests\/fixture\/flaky\.test\.ts failed on run 2 of 4/);

  // An input carrying shell syntax stays data: it reaches the script as an
  // env value, which refuses it, and nothing it names is executed.
  const hostile = await dispatch({ tests: 'tests/fixture/alpha.test.ts"; touch pwned; echo "', repeat: "1$(touch pwned)" });
  assert.equal(hostile.status, "failure");
  assert.match(hostile.steps.at(-1)!.output, /repeat must be a positive integer|not a tests/);
  assert.equal(existsSync(join(dir, "pwned")), false, "an input was executed as shell");
});
