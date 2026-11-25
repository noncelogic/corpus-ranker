// Deploy queue acceptance (owner INTENTS I67, DELIVERY-GUARANTEE-CHECK;
// Rule: policies/placement-defaults.yaml#gates): merges run the fast checks
// only (ci.yml), and .github/workflows/deploy.yml is the deploy lane. The
// conductor dispatches it once per batch with the batch id and the candidate
// (the full commit SHA of the batch's newest merged commit); it checks that
// commit out, builds the candidate image from it, deploys it with its
// Postgres and MinIO (database bootstrapped and migrated from the candidate
// image as deploy/ does), waits for /readyz, runs the E2E suite and then the
// journeys against the deployed service, and always tears the deployment down.
// A red E2E or journey fails the batch run, so its failure goes back to the
// changes in the batch.
//
// The workflow is run whole, as written, by the local runner
// (tests/ci/workflow-runner.ts) in a scratch git checkout of the repository's
// workflows, scripts, package.json and deploy/db. `docker` is a stand-in that
// records every call and refuses any it does not expect; the deployed service
// is a local HTTP server on port 0 that the stand-in's `docker port` names,
// and fails any request it does not route. The E2E and journey suites are
// fixture files the real `npm run test:e2e` / `npm run test:journeys` select,
// probing that server with the URL and API key the deploy handed them.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readWorkflow, runEvent, triggers, type JobRun } from "./workflow-runner.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW = resolve(repoRoot, ".github", "workflows", "deploy.yml");
const OTHER_SHA = "c0ffee" + "1".repeat(34);

type Map_ = Record<string, unknown>;
const steps = (job: Map_) => job.steps as Map_[];

test("deploy.yml is the deploy queue: dispatched per batch with the candidate, read-only, and one job deploys the candidate and runs its E2E and journeys", () => {
  const workflow = readWorkflow(WORKFLOW);
  const on = workflow.on as Record<string, { inputs: Record<string, Map_> }>;
  assert.deepEqual(Object.keys(on), ["workflow_dispatch"], "dispatch only: a merge never deploys by itself (no push, workflow_run or schedule)");
  assert.deepEqual(Object.keys(on.workflow_dispatch.inputs).sort(), ["batch", "candidate"]);
  for (const input of ["batch", "candidate"]) assert.equal(on.workflow_dispatch.inputs[input]!.required, true, `${input} is required`);
  assert.equal(workflow["run-name"], "deploy-batch:${{ inputs.batch }}");
  assert.deepEqual(workflow.permissions, { contents: "read" });
  for (const name of ["push", "pull_request"] as const) {
    assert.equal(triggers(workflow, { name, ref: name === "push" ? "refs/heads/main" : "refs/pull/1/merge", sha: OTHER_SHA }), false, `fires on ${name}`);
  }

  const jobs = workflow.jobs as Record<string, Map_>;
  assert.deepEqual(Object.keys(jobs), ["deploy"]);
  const job = jobs.deploy!;
  assert.equal(job.permissions, undefined, "no job-level permissions widen contents: read");
  assert.equal(job.if, undefined, "the job runs on every dispatch");
  const ci = readWorkflow(resolve(repoRoot, ".github", "workflows", "ci.yml")) as { jobs: Record<string, Map_> };
  assert.deepEqual(job["runs-on"], ci.jobs.test!["runs-on"], "the deploy lane runs where ci.yml's test job already runs the compose replica");

  const checkouts = steps(job).filter((s) => String(s.uses ?? "").startsWith("actions/checkout@"));
  assert.equal(checkouts.length, 1);
  assert.deepEqual(checkouts[0]!.with, { ref: "${{ inputs.candidate }}", "persist-credentials": false }, "the immutable candidate is checked out, never the moving branch head");
  for (const s of steps(job)) {
    if (typeof s.run === "string") assert.doesNotMatch(s.run, /\$\{\{/, `a run script interpolates an expression: ${s.run}`);
    assert.ok(s.if === undefined || s.if === "always()", `step ${String(s.name)} runs on a condition the batch cannot prove: ${String(s.if)}`);
  }
  assert.deepEqual(job.env, { CANDIDATE: "${{ inputs.candidate }}", BATCH: "${{ inputs.batch }}" }, "the inputs reach the script through env only");
});

interface Lane {
  dir: string;
  candidate: string;
  /** The stand-in docker's calls and the deployed service's requests, in the order they happened. */
  log: () => string[];
  dispatch: (inputs: { candidate: string; batch: string }, env?: Record<string, string>) => Promise<JobRun>;
}

/**
 * A scratch git checkout holding the deploy lane, a stand-in docker, and a
 * local server standing in for the deployed candidate. `service.ready` is
 * what GET /readyz answers; `service.e2e` what the E2E probe answers.
 */
async function lane(t: TestContext, service: { ready: number; e2e: number }): Promise<Lane> {
  const dir = mkdtempSync(join(tmpdir(), "deploy-lane-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const logFile = join(dir, "lane.log");
  writeFileSync(logFile, "");
  const record = (line: string) => appendFileSync(logFile, `${line}\n`);

  const server = createServer((req, res) => {
    const auth = req.headers.authorization ?? "";
    const reply = (status: number) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end("{}");
    };
    if (req.method === "GET" && req.url === "/readyz") {
      record(`service GET /readyz -> ${service.ready}`);
      return reply(service.ready);
    }
    if (req.method === "GET" && (req.url === "/e2e-probe" || req.url === "/journey-probe")) {
      record(`service GET ${req.url} ${auth}`);
      return reply(req.url === "/e2e-probe" ? service.e2e : 200);
    }
    record(`service UNEXPECTED ${req.method} ${req.url}`);
    reply(599);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(() => server.close());
  const addr = `127.0.0.1:${(server.address() as AddressInfo).port}`;

  cpSync(join(repoRoot, ".github"), join(dir, ".github"), { recursive: true });
  cpSync(join(repoRoot, "deploy", "db"), join(dir, "deploy", "db"), { recursive: true });
  cpSync(join(repoRoot, "package.json"), join(dir, "package.json"));
  // Fixture suites in the places the package.json suite scripts select.
  const probe = (path: string) => `import { test } from "node:test";
import assert from "node:assert/strict";
test("probe ${path}", async () => {
  const r = await fetch(process.env.RANKER_E2E_URL + "${path}", { headers: { authorization: "Bearer " + process.env.RANKER_E2E_API_KEY } });
  assert.equal(r.status, 200);
});
`;
  mkdirSync(join(dir, "tests", "e2e"), { recursive: true });
  mkdirSync(join(dir, "tests", "journeys"), { recursive: true });
  writeFileSync(join(dir, "tests", "e2e", "probe.e2e.ts"), probe("/e2e-probe"));
  writeFileSync(join(dir, "tests", "journeys", "probe.journey.ts"), probe("/journey-probe"));

  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=lane", "-c", "user.email=lane@example.invalid", ...args], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "candidate");
  const candidate = git("rev-parse", "HEAD");

  // The stand-in docker: records each call, answers `docker port` with the
  // stand-in service and refuses any subcommand the lane should not use.
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/bash
echo "docker $*" >> "${logFile}"
case "$1" in
  build|logs|rm) ;;
  run)
    if [ "$2" = -d ]; then echo 0123456789ab; fi ;;
  port) echo "${addr}" ;;
  compose)
    case "$6" in
      up|down) ;;
      exec) cat > /dev/null ;;
      *) echo "fake docker: unexpected compose $6" >&2; exit 2 ;;
    esac ;;
  *) echo "fake docker: unexpected $1" >&2; exit 2 ;;
esac
`,
  );
  chmodSync(join(bin, "docker"), 0o755);

  return {
    dir,
    candidate,
    log: () => readFileSync(logFile, "utf8").split("\n").filter(Boolean),
    dispatch: async (inputs, env = {}) => {
      const [run] = await runEvent({
        workflowsDir: join(dir, ".github", "workflows"),
        workflows: ["deploy.yml"],
        event: { name: "workflow_dispatch", ref: "refs/heads/main", sha: OTHER_SHA, inputs },
        workspace: dir,
        repository: "noncelogic/corpus-ranker",
        hostEnv: { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: dir, ...env },
      });
      assert.ok(run, "deploy.yml ran for workflow_dispatch");
      return run;
    },
  };
}

const output = (run: JobRun) => run.steps.map((s) => `--- ${s.name} (${s.status})\n${s.output}`).join("\n");
const at = (log: string[], pattern: RegExp, what: string): number => {
  const i = log.findIndex((l) => pattern.test(l));
  assert.ok(i >= 0, `${what} never happened:\n${log.join("\n")}`);
  return i;
};

test("a dispatched batch builds the candidate, deploys it, runs E2E then journeys against the deployed service, and tears it down", async (t) => {
  const l = await lane(t, { ready: 200, e2e: 200 });
  const run = await l.dispatch({ candidate: l.candidate, batch: "2026-11-25T17" });
  assert.equal(run.status, "success", output(run));
  const log = l.log();
  const project = `crdeploy-${l.candidate.slice(0, 12)}`;
  const image = `corpus-ranker:candidate-${l.candidate}`;

  const build = at(log, new RegExp(`^docker build .*--label org\\.opencontainers\\.image\\.revision=${l.candidate} .*-t ${image} \\.$`), "the candidate image build, labelled with the candidate commit");
  const up = at(log, new RegExp(`^docker compose -f docker-compose\\.yaml -p ${project} up -d --wait .*postgres minio$`), "the backing services coming up");
  const migrations = at(log, new RegExp(`^docker run --rm --entrypoint tar ${image} `), "the migrations copied out of the candidate image");
  const migrate = at(log, new RegExp(`^docker compose .* -p ${project} exec -T .*PGUSER=ranker_migrator .*postgres sh -s `), "deploy/db/migrate.sh run as the migrator");
  const service = at(log, new RegExp(`^docker run -d --name ${project}-api --network ${project}_default .*RANKER_API_KEYS_DIR=/keys .* ${image}$`), "the candidate service started");
  const ready = at(log, /^service GET \/readyz -> 200$/, "the readiness wait");
  const e2e = at(log, /^service GET \/e2e-probe Bearer \S+$/, "the E2E suite against the deployed service");
  const journey = at(log, /^service GET \/journey-probe Bearer \S+$/, "the journeys against the deployed service");
  const down = at(log, new RegExp(`^docker compose .* -p ${project} down -v --remove-orphans$`), "the teardown");
  assert.ok(build < up && up < migrations && migrations < migrate && migrate < service && service < ready, log.join("\n"));
  assert.ok(ready < e2e && e2e < journey && journey < down, log.join("\n"));
  assert.equal(log[e2e]!.split(" ").at(-1), log[journey]!.split(" ").at(-1), "both suites carry the API key the deployed service was given");
  assert.ok(!log.some((l) => /UNEXPECTED/.test(l)), log.join("\n"));
  assert.match(output(run), new RegExp(`batch 2026-11-25T17: candidate ${l.candidate} deployed at http://127\\.0\\.0\\.1:\\d+`));
});

test("a red E2E fails the batch: journeys do not run on a broken candidate and the deployment is still torn down", async (t) => {
  const l = await lane(t, { ready: 200, e2e: 500 });
  const run = await l.dispatch({ candidate: l.candidate, batch: "b-7" });
  assert.equal(run.status, "failure", output(run));
  const log = l.log();
  assert.deepEqual(run.steps.map((s) => [s.name, s.status]).slice(2), [
    ["Deploy the candidate", "success"],
    ["E2E", "failure"],
    ["Journeys", "skipped"],
    ["Tear down", "success"],
  ]);
  at(log, /^service GET \/e2e-probe Bearer \S+$/, "the E2E suite reaching the deployed service");
  assert.ok(!log.some((l) => /journey-probe/.test(l)), log.join("\n"));
  at(log, /^docker rm -f crdeploy-\w+-api$/, "the service container removed");
  at(log, / down -v --remove-orphans$/, "the backing services removed");
});

test("a candidate that never becomes ready fails the deploy within the bound, runs no suite and is torn down", async (t) => {
  const l = await lane(t, { ready: 503, e2e: 200 });
  const run = await l.dispatch({ candidate: l.candidate, batch: "b-8" }, { DEPLOY_READY_SECONDS: "2" });
  assert.equal(run.status, "failure", output(run));
  assert.match(output(run), /\/readyz not ready within 2s \(last: HTTP 503\)/);
  assert.deepEqual(run.steps.map((s) => s.status).slice(2), ["failure", "skipped", "skipped", "success"]);
  const log = l.log();
  assert.ok(!log.some((l) => /probe/.test(l)), log.join("\n"));
  at(log, / down -v --remove-orphans$/, "the teardown");
});

test("a candidate that is not the checked-out full commit SHA, or a batch id carrying shell syntax, is refused before anything is built or deployed", async (t) => {
  const l = await lane(t, { ready: 200, e2e: 200 });
  const refused: [{ candidate: string; batch: string }, RegExp][] = [
    [{ candidate: "main", batch: "b" }, /candidate must be a full 40-character commit SHA, got 'main'/],
    [{ candidate: l.candidate.slice(0, 12), batch: "b" }, /candidate must be a full 40-character commit SHA/],
    [{ candidate: l.candidate.toUpperCase(), batch: "b" }, /candidate must be a full 40-character commit SHA/],
    [{ candidate: `${l.candidate}$(touch pwned)`, batch: "b" }, /candidate must be a full 40-character commit SHA/],
    [{ candidate: OTHER_SHA, batch: "b" }, new RegExp(`the checkout is at ${l.candidate}, not the candidate ${OTHER_SHA}`)],
    [{ candidate: l.candidate, batch: "" }, /batch must be 1-64 letters, digits/],
    [{ candidate: l.candidate, batch: "b; touch pwned" }, /batch must be 1-64 letters, digits/],
    [{ candidate: l.candidate, batch: "b$(touch pwned)" }, /batch must be 1-64 letters, digits/],
  ];
  for (const [inputs, message] of refused) {
    const run = await l.dispatch(inputs);
    assert.equal(run.status, "failure", `${JSON.stringify(inputs)} was accepted:\n${output(run)}`);
    assert.match(run.steps.find((s) => s.name === "Deploy the candidate")!.output, message, output(run));
    assert.match(run.steps.find((s) => s.name === "Tear down")!.output, /nothing deployed/);
  }
  assert.deepEqual(l.log(), [], "no docker call and no request to a service");
  assert.equal(existsSync(join(l.dir, "pwned")), false, "an input was executed as shell");
});
