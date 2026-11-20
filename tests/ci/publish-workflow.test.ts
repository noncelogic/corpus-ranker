// CR-PUBLISH-OIDC acceptance (INTENTS I25; policy ci-job-definitions; follows
// CR-IMAGE-ACR, INTENTS I21; Rule: policies/placement-defaults.yaml#credentials):
// .github/workflows/publish.yml builds the ranker image once per merge to
// main on the ranker's dedicated self-hosted runner (labels self-hosted, aks,
// corpus-ranker-ci) and pushes it to the estate Azure registry as
// noncelogicci.azurecr.io/corpus-ranker:sha-<commit>. The runner mounts no
// credentials: the Publish step mints a GitHub OIDC token (audience openbao),
// logs in to OPENBAO_ADDR at auth/jwt with role corpus-ranker-registry-push,
// reads kv/data/corpus-ranker/acr-push and logs docker in to the registry it
// names, password on stdin, never printing a token or the password. It no
// longer reads /etc/registry-push.
//
// The workflows are run whole, as written, by a local runner
// (tests/ci/workflow-runner.ts) for a push to main or a pull request, against
// stand-in `docker`, `npm` and `kustomize` binaries that record what they are
// asked to do, and one local HTTP server standing in for both the GitHub OIDC
// token endpoint and OpenBao. Refusals are the fake estate's behaviour; the
// production workflow and credential script are never edited.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readWorkflow, runEvent, triggers, type JobRun, type WorkflowEvent } from "./workflow-runner.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowsDir = resolve(repoRoot, ".github", "workflows");
const REGISTRY = "noncelogicci.azurecr.io";
const IMAGE = `${REGISTRY}/corpus-ranker`;
/** Labels the ranker's dedicated runner carries (meta-harness devops/aks/corpus-ranker-argo/README.md). */
const RUNNER_LABELS = ["self-hosted", "aks", "corpus-ranker-ci"];
/** Stand-in docker image state (build records platform and labels, image inspect reads them back). */
const FAKE_DOCKER = resolve(repoRoot, "tests", "ci", "fake-docker.sh");

const SHA = "6ab0ef3fcd436dbd8075c030382ee75b6005a10b";
const PUSH_MAIN: WorkflowEvent = { name: "push", ref: "refs/heads/main", sha: SHA };
const PULL_REQUEST: WorkflowEvent = { name: "pull_request", ref: "refs/pull/64/merge", sha: SHA };
const ROLE = "corpus-ranker-registry-push";
const SECRET = "/v1/kv/data/corpus-ranker/acr-push";
const OIDC_REQUEST_TOKEN = "gh-request-" + "R".repeat(32);
const OIDC_JWT = "eyJ" + "J".repeat(60);
const BAO_TOKEN = "hvs." + "B".repeat(40);
const PASSWORD = "acr-" + "P".repeat(40);
const GOOD = { registry: REGISTRY, username: "corpus-ranker-push", password: PASSWORD };

interface Estate {
  creds: { registry: string; username: string; password: string };
  /** OpenBao refuses every auth/jwt login (e.g. the role's bound claims do not match). */
  refuseLogin?: boolean;
  /**
   * Pull-request posture: every credential source is a tripwire that refuses
   * and records the access — the OIDC endpoint and OpenBao answer 403, a
   * registry login, push or pull fails, a read of the runner-mount decoy
   * yields nothing, and every `secrets.*` the runner evaluates is logged.
   */
  tripwires?: boolean;
}

/**
 * One local server standing in for the GitHub OIDC token endpoint (GET
 * /oidc?audience=...) and OpenBao. OpenBao only accepts the JWT minted for
 * audience openbao, only under role corpus-ranker-registry-push, and only
 * serves the secret to the token that login issued, as the estate role does.
 */
async function fakeEstate(t: TestContext, estate: Estate): Promise<{ url: string; requests: string[] }> {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      requests.push(`${req.method} ${url.pathname}`);
      const send = (status: number, json: unknown): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(json));
      };
      if (estate.tripwires) return send(403, { errors: ["tripwire: no credential access from a pull request"] });
      if (req.method === "GET" && url.pathname === "/oidc") {
        if (req.headers.authorization !== `Bearer ${OIDC_REQUEST_TOKEN}`) return send(401, {});
        if (url.searchParams.get("audience") !== "openbao") return send(200, { value: "jwt-for-another-audience" });
        return send(200, { value: OIDC_JWT });
      }
      if (req.method === "POST" && url.pathname === "/v1/auth/jwt/login") {
        const { role, jwt } = JSON.parse(body || "{}") as { role?: string; jwt?: string };
        if (estate.refuseLogin || role !== ROLE || jwt !== OIDC_JWT) return send(403, { errors: ["permission denied"] });
        return send(200, { auth: { client_token: BAO_TOKEN } });
      }
      if (req.method === "GET" && url.pathname === SECRET) {
        if (req.headers["x-vault-token"] !== BAO_TOKEN) return send(403, { errors: ["permission denied"] });
        return send(200, { data: { data: estate.creds, metadata: { version: 1 } } });
      }
      if (req.method === "POST" && url.pathname === "/v1/auth/token/revoke-self") return send(204, {});
      return send(404, { errors: [] });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests };
}

interface Simulation {
  jobs: JobRun[];
  /** Every docker/npm/kustomize invocation, in order, as "<tool> <argv>". */
  calls: string[];
  /** Every docker invocation as "<workflow name>/<job id> DRY_RUN_OF=<value> <subcommand>" (from GITHUB_WORKFLOW, GITHUB_JOB). */
  dockerJobs: string[];
  requests: string[];
  /**
   * Every credential access the tripwires recorded (Estate.tripwires): "oidc
   * <path>", "openbao <path>", "registry <login|push|pull>", "mount <file>",
   * "secret <name>". Empty when tripwires are off.
   */
  access: string[];
  loginStdin?: string;
  output: string;
}

/**
 * Run the repository's workflows for `event` on the local runner. Stand-in
 * docker, npm and kustomize record their argv (and docker login's stdin). A
 * decoy of the old runner mount, holding a different credential, is offered
 * to every step as REGISTRY_PUSH_DIR: nothing may use it.
 */
interface SimulateOptions {
  /** Workflow files to run; default every workflow the event triggers. */
  workflows?: string[];
  /** Extra host environment, e.g. the stand-in docker's FAKE_DOCKER_* faults. */
  env?: Record<string, string>;
  /** Checkout to run in (default the repository itself); its .github/workflows are the ones run. */
  workspace?: string;
  /** vars.OPENBAO_ADDR as the workflow sees it (default the stand-in estate). */
  openbaoAddr?: string;
}

/**
 * Turn each runner-mount decoy file into a FIFO watched by a writer loop: a
 * step that opens it is recorded as "mount <file>" and reads nothing, so the
 * credential it hoped for is empty.
 */
async function mountTripwire(t: TestContext, decoy: string, log: string): Promise<void> {
  for (const file of ["registry", "username", "password"]) {
    const fifo = join(decoy, file);
    const mkfifo = spawn("mkfifo", [fifo], { stdio: "ignore" });
    const [code] = (await once(mkfifo, "close")) as [number | null];
    assert.equal(code, 0, `mkfifo ${fifo}`);
    const writer = spawn("bash", ["-c", 'while :; do exec 3>"$1"; echo "mount $2" >> "$3"; exec 3>&-; done', "_", fifo, file, log], {
      stdio: "ignore",
    });
    t.after(() => writer.kill("SIGKILL"));
  }
}

async function simulate(t: TestContext, event: WorkflowEvent, estate: Estate, opts: SimulateOptions = {}): Promise<Simulation> {
  const fake = await fakeEstate(t, estate);
  const dir = mkdtempSync(join(tmpdir(), "publish-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const decoy = join(dir, "registry-push");
  const accessLog = join(dir, "access");
  for (const d of [bin, decoy]) mkdirSync(d);
  if (estate.tripwires) {
    await mountTripwire(t, decoy, accessLog);
  } else {
    writeFileSync(join(decoy, "registry"), `${REGISTRY}\n`);
    writeFileSync(join(decoy, "username"), "mounted-user\n");
    writeFileSync(join(decoy, "password"), "mounted-password\n");
  }
  const dockerState = join(dir, "docker-state");
  mkdirSync(dockerState);
  for (const tool of ["docker", "npm", "kustomize"]) {
    writeFileSync(
      join(bin, tool),
      `#!/bin/bash\nargs="$*"; echo "${tool} \${args//$'\\n'/ }" >> "${dir}/calls"\n` +
        (tool === "docker"
          ? `echo "\${GITHUB_WORKFLOW}/\${GITHUB_JOB} DRY_RUN_OF=\${DRY_RUN_OF-} $1" >> "${dir}/docker-jobs"\n` +
            (estate.tripwires ? `case "$1" in login|push|pull) echo "registry $1" >> "${accessLog}"; exit 1 ;; esac\n` : "") +
            `case "$1" in login) cat > "${dir}/login-stdin" ;; esac\nDOCKER_STATE="${dockerState}"\n. "${FAKE_DOCKER}" "$@"\n`
          : "") +
        "exit 0\n",
    );
    chmodSync(join(bin, tool), 0o755);
  }

  const workspace = opts.workspace ?? repoRoot;
  const secretReads: string[] = [];
  const jobs = await runEvent({
    workflowsDir: resolve(workspace, ".github", "workflows"),
    workflows: opts.workflows,
    event,
    workspace,
    repository: "noncelogic/corpus-ranker",
    vars: { OPENBAO_ADDR: opts.openbaoAddr ?? fake.url },
    hostEnv: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, REGISTRY_PUSH_DIR: decoy, ...opts.env },
    oidc: { url: `${fake.url}/oidc?api-version=2.0`, token: OIDC_REQUEST_TOKEN },
    onSecretRead: (name) => secretReads.push(name),
  });
  const read = (f: string): string | undefined => {
    try {
      return readFileSync(join(dir, f), "utf8");
    } catch {
      return undefined;
    }
  };
  return {
    jobs,
    calls: (read("calls") ?? "").trim().split("\n").filter(Boolean),
    dockerJobs: (read("docker-jobs") ?? "").trim().split("\n").filter(Boolean),
    requests: fake.requests,
    access: estate.tripwires
      ? [
          ...fake.requests.map((r) => (r.includes(" /oidc") ? `oidc ${r}` : `openbao ${r}`)),
          // The FIFO writer may record one open more than once while the reader holds it.
          ...new Set((read("access") ?? "").trim().split("\n").filter(Boolean)),
          ...secretReads.map((n) => `secret ${n}`),
        ]
      : [],
    loginStdin: read("login-stdin"),
    output: jobs.flatMap((j) => j.steps.map((s) => s.output)).join("\n"),
  };
}

const publishJob = (sim: Simulation): JobRun => {
  const jobs = sim.jobs.filter((j) => j.workflow === "publish.yml");
  assert.equal(jobs.length, 1, "publish.yml has exactly one job");
  return jobs[0]!;
};

test("publish logs in through OpenBao JWT role corpus-ranker-registry-push and never reads the runner mount", async (t) => {
  // The runner mount is gone from the workflow (the defect this task removes).
  const source = readFileSync(resolve(workflowsDir, "publish.yml"), "utf8");
  assert.doesNotMatch(source, /\/etc\/registry-push/, "publish.yml does not read the runner mount /etc/registry-push");
  assert.doesNotMatch(source, /REGISTRY_PUSH_DIR/, "publish.yml does not read REGISTRY_PUSH_DIR");

  // A push to main runs publish.yml as written: OIDC (audience openbao) ->
  // OpenBao JWT login with the bound role -> read the push token -> docker
  // login to the registry it names, password on stdin (the credential
  // preflight) -> build -> push the SHA tag -> log out.
  const ok = await simulate(t, PUSH_MAIN, { creds: GOOD }, { workflows: ["publish.yml"] });
  const job = publishJob(ok);
  assert.equal(job.status, "success", ok.output);
  assert.deepEqual(job.runsOn, ["self-hosted", "corpus-ranker-ci"], "runs-on stays [self-hosted, corpus-ranker-ci]");
  assert.deepEqual((job.runsOn as string[]).filter((l) => !RUNNER_LABELS.includes(l)), [], "every label is one the ranker's runner carries");
  assert.deepEqual(job.permissions, { contents: "read", "id-token": "write" }, "contents: read and id-token: write only; no packages");
  assert.ok(job.oidcOffered, "the job is granted id-token: write, so it can mint the OIDC token");
  assert.deepEqual(ok.requests, ["GET /oidc", "POST /v1/auth/jwt/login", `GET ${SECRET}`, "POST /v1/auth/token/revoke-self"]);
  assert.equal(ok.calls.length, 4, ok.calls.join("\n"));
  assert.equal(ok.calls[0], `docker login ${REGISTRY} -u corpus-ranker-push --password-stdin`);
  assert.match(ok.calls[1]!, new RegExp(`^docker build .* -t ${IMAGE}:sha-${SHA} \\.$`), "builds the SHA-tagged image");
  assert.deepEqual(ok.calls.slice(2), [`docker push ${IMAGE}:sha-${SHA}`, `docker logout ${REGISTRY}`]);
  assert.equal(ok.loginStdin, PASSWORD, "the fetched password reaches docker login on stdin");
  assert.doesNotMatch(ok.calls.join(" "), /mounted-/, "nothing from the runner mount is used");
  for (const secret of [PASSWORD, BAO_TOKEN, OIDC_JWT, OIDC_REQUEST_TOKEN]) {
    assert.ok(!ok.calls.join(" ").includes(secret), "no token or password goes on argv");
    assert.ok(!ok.output.includes(secret), "no token or password is printed");
  }

  // OpenBao refuses the login (e.g. the role's bound claims do not match):
  // the job fails, no secret is read, nothing is logged in to or pushed.
  const refused = await simulate(t, PUSH_MAIN, { creds: GOOD, refuseLogin: true }, { workflows: ["publish.yml"] });
  assert.equal(publishJob(refused).status, "failure", "a login OpenBao refuses must fail the job");
  assert.deepEqual(refused.requests, ["GET /oidc", "POST /v1/auth/jwt/login"]);
  assert.deepEqual(refused.calls.filter((c) => !/^docker (build|logout) /.test(c)), [], "nothing is logged in to or pushed without the OpenBao credential");
  assert.ok(!refused.output.includes(OIDC_JWT), "the OIDC token is not printed on refusal");

  // A credential for another registry is refused before any login or push.
  const wrong = await simulate(t, PUSH_MAIN, { creds: { registry: "ghcr.io", username: "u", password: PASSWORD } }, { workflows: ["publish.yml"] });
  assert.equal(publishJob(wrong).status, "failure", "a push credential for another registry must fail the job");
  assert.deepEqual(wrong.calls.filter((c) => !/^docker (build|logout) /.test(c)), [], "nothing is logged in to or pushed with a mismatched credential");
  assert.ok(!wrong.output.includes(PASSWORD), "the password is not printed on refusal");
});

test("publish installs node before the credential preflight runs the credential script on the node-less self-hosted runner", async (t) => {
  // Red main 44693705144..44824828516: every publish since CR-PUBLISH-OIDC
  // failed on runner corpus-ranker-ci-aks-01 with `node: command not found`,
  // so no sha-<commit> image reached the registry for the rollout to pin.
  // The local runner gives a self-hosted job no node until setup-node runs.
  const workflow = readWorkflow(resolve(workflowsDir, "publish.yml"));
  const steps = ((workflow.jobs as Record<string, { steps: { name?: string; uses?: string; with?: Record<string, unknown> }[] }>).image).steps;
  const setup = steps.findIndex((s) => String(s.uses ?? "").startsWith("actions/setup-node@"));
  const preflight = steps.findIndex((s) => s.name === "Registry credential preflight");
  assert.ok(setup >= 0 && setup < preflight, "a pinned actions/setup-node step precedes the credential preflight");
  assert.match(String(steps[setup]!.uses), /^actions\/setup-node@[0-9a-f]{40}$/, "setup-node is pinned to a commit");
  assert.equal(String(steps[setup]!.with?.["node-version"]), "24", "the same Node major as ci.yml and the image");

  const ok = await simulate(t, PUSH_MAIN, { creds: GOOD }, { workflows: ["publish.yml"] });
  const job = publishJob(ok);
  assert.equal(job.status, "success", ok.output);
  assert.doesNotMatch(ok.output, /command not found/);
  assert.deepEqual(ok.calls.filter((c) => c.startsWith("docker push ")), [`docker push ${IMAGE}:sha-${SHA}`]);
});

test("ci.yml no longer publishes, so each merge to main pushes the image exactly once", async (t) => {
  // A merge to main: every workflow it triggers runs, and exactly one image
  // push happens in total — publish.yml's SHA tag. ci.yml's image job only
  // builds (the pull-request dry run) and its ci-result gate (if: always())
  // reads every need's result.
  const merge = await simulate(t, PUSH_MAIN, { creds: GOOD });
  const ran = merge.jobs.filter((j) => j.status !== "skipped").map((j) => `${j.workflow}/${j.job}`);
  assert.deepEqual(ran.sort(), ["ci.yml/ci-result", "ci.yml/image", "ci.yml/test", "publish.yml/image"], merge.output);
  assert.ok(merge.jobs.every((j) => j.status !== "failure"), merge.output);
  assert.deepEqual(merge.calls.filter((c) => c.startsWith("docker push ")), [`docker push ${IMAGE}:sha-${SHA}`], "one push per merge");
  assert.equal(merge.calls.filter((c) => c.startsWith("docker login ")).length, 1, "one registry login per merge");
  assert.equal(merge.requests.filter((r) => r === "POST /v1/auth/jwt/login").length, 1, "one OpenBao login per merge");

  // A pull request: publish.yml does not run at all, nothing logs in or
  // pushes, no OIDC token is minted, and no job lands on a self-hosted runner.
  const pr = await simulate(t, PULL_REQUEST, { creds: GOOD });
  assert.ok(pr.jobs.length > 0, "ci.yml runs for pull requests");
  assert.deepEqual(pr.jobs.filter((j) => j.workflow === "publish.yml"), [], "publish.yml is not triggered by a pull request");
  assert.ok(pr.jobs.every((j) => j.status !== "failure"), pr.output);
  assert.deepEqual(pr.calls.filter((c) => /^docker (push|login) /.test(c)), [], "a pull request pushes nothing");
  assert.deepEqual(pr.requests, [], "a pull request never reaches the OIDC endpoint or OpenBao");
  assert.ok(pr.calls.some((c) => c.startsWith("docker build ")), "the pull request still builds the image");
  for (const j of pr.jobs) {
    assert.ok(!JSON.stringify(j.runsOn).includes("self-hosted"), `${j.workflow}/${j.job} stays off self-hosted runners`);
  }
});

// CR-GATE-IMAGE-DRYRUN acceptance (policy main-stays-green): ci.yml's `image`
// job is the declared, secret-free pull-request dry run of publish.yml's
// `image` job. Both build through the one definition in
// .github/scripts/image-build.sh, and the dry run checks the built image's
// manifest platform and metadata labels against what publish pushes, under
// the strict ci-result gate (devops/github/branch-protection.json).

const PR_TAG = "corpus-ranker:ci";
const PUBLISH_TAG = `${IMAGE}:sha-${SHA}`;
const LABELS = [
  "org.opencontainers.image.source=https://github.com/noncelogic/corpus-ranker",
  `org.opencontainers.image.revision=${SHA}`,
];

type Jobs = Record<string, Record<string, unknown>>;
const jobsOf = (file: string): Jobs => readWorkflow(resolve(workflowsDir, file)).jobs as unknown as Jobs;
const ciJob = (sim: Simulation, id: string): JobRun => {
  const j = sim.jobs.find((x) => x.workflow === "ci.yml" && x.job === id);
  assert.ok(j, `ci.yml ran no job ${id}`);
  return j;
};
const builds = (sim: Simulation): string[] => sim.calls.filter((c) => c.startsWith("docker build "));

/**
 * A scratch checkout of the repository's workflows and scripts in which the
 * shared build definition is edited by `edit`: what both workflows then pass
 * docker shows whether they really build from that one definition.
 */
function checkoutWith(t: TestContext, edit: (definition: string) => string): string {
  const ws = mkdtempSync(join(tmpdir(), "checkout-"));
  t.after(() => rmSync(ws, { recursive: true, force: true }));
  cpSync(resolve(repoRoot, ".github"), join(ws, ".github"), { recursive: true });
  const definition = join(ws, ".github", "scripts", "image-build.sh");
  const before = readFileSync(definition, "utf8");
  const after = edit(before);
  assert.notEqual(after, before, "the probe edit changed the shared build definition");
  writeFileSync(definition, after);
  return ws;
}

test("ci.yml's image job declares DRY_RUN_OF image and builds from the same build inputs as publish.yml's image job", async (t) => {
  // Run as written: the pull request's build and main's publish build pass
  // docker the same Dockerfile, context, platform, build arguments and
  // labels; only the tag differs.
  const pr = await simulate(t, PULL_REQUEST, { creds: GOOD }, { workflows: ["ci.yml"] });
  const main = await simulate(t, PUSH_MAIN, { creds: GOOD }, { workflows: ["publish.yml"] });
  assert.equal(builds(pr).length, 1, pr.calls.join("\n"));
  assert.equal(builds(main).length, 1, main.calls.join("\n"));
  const expected = `docker build -f Dockerfile --platform linux/amd64 ${LABELS.map((l) => `--label ${l}`).join(" ")} -t <tag> .`;
  assert.equal(builds(pr)[0]!.replace(` -t ${PR_TAG} `, " -t <tag> "), expected, "the pull request builds from the shared inputs");
  assert.equal(builds(main)[0]!.replace(` -t ${PUBLISH_TAG} `, " -t <tag> "), expected, "publish builds from the shared inputs");
  assert.equal(ciJob(pr, "image").status, "success", pr.output);

  // DRY_RUN_OF as the running job sees it: the pull request's build runs in
  // ci/image with DRY_RUN_OF=image, and the job it names is the one whose
  // build main publishes (publish/image, itself no dry run).
  const prBuilds = pr.dockerJobs.filter((j) => j.endsWith(" build"));
  const mainBuilds = main.dockerJobs.filter((j) => j.endsWith(" build"));
  assert.deepEqual(prBuilds, ["ci/image DRY_RUN_OF=image build"], pr.dockerJobs.join("\n"));
  const named = /DRY_RUN_OF=(\S+)/.exec(prBuilds[0]!)![1]!;
  assert.deepEqual(mainBuilds, [`publish/${named} DRY_RUN_OF= build`], "DRY_RUN_OF names the publish job that builds what main pushes");

  // One shared definition, observed: change every build input in the shared
  // definition only, and both workflows' builds change the same way, while
  // the pull request's manifest check still passes against it.
  const ws = checkoutWith(t, (d) =>
    d
      .replace('IMAGE_DOCKERFILE="Dockerfile"', 'IMAGE_DOCKERFILE="Dockerfile.probe"')
      .replace('IMAGE_CONTEXT="."', 'IMAGE_CONTEXT="probe-context"')
      .replace('IMAGE_PLATFORM="linux/amd64"', 'IMAGE_PLATFORM="linux/arm64"')
      .replace("IMAGE_BUILD_ARGS=()", "IMAGE_BUILD_ARGS=(PROBE_ARG=1)")
      .replace('echo "org.opencontainers.image.revision=${GITHUB_SHA}"', 'echo "org.opencontainers.image.revision=${GITHUB_SHA}"\n  echo "probe.label=1"'),
  );
  const prProbe = await simulate(t, PULL_REQUEST, { creds: GOOD }, { workflows: ["ci.yml"], workspace: ws });
  const mainProbe = await simulate(t, PUSH_MAIN, { creds: GOOD }, { workflows: ["publish.yml"], workspace: ws });
  const probed =
    "docker build -f Dockerfile.probe --platform linux/arm64 --build-arg PROBE_ARG=1 " +
    `${[...LABELS, "probe.label=1"].map((l) => `--label ${l}`).join(" ")} -t <tag> probe-context`;
  assert.deepEqual(builds(prProbe).map((b) => b.replace(` -t ${PR_TAG} `, " -t <tag> ")), [probed], prProbe.output);
  assert.deepEqual(builds(mainProbe).map((b) => b.replace(` -t ${PUBLISH_TAG} `, " -t <tag> ")), [probed], mainProbe.output);
  assert.equal(ciJob(prProbe, "image").status, "success", prProbe.output);
});

test("the pull-request image job fails when the built image's manifest or metadata labels differ from what publish pushes", async (t) => {
  // The build as defined passes the check, and the check really reads the built image.
  const ok = await simulate(t, PULL_REQUEST, { creds: GOOD }, { workflows: ["ci.yml"] });
  assert.equal(ciJob(ok, "image").status, "success", ok.output);
  assert.ok(ok.calls.some((c) => c.startsWith(`docker image inspect `) && c.endsWith(` ${PR_TAG}`)), ok.calls.join("\n"));
  assert.equal(ciJob(ok, "ci-result").status, "success", ok.output);

  const faults: Array<[string, Record<string, string>, RegExp]> = [
    ["another platform", { FAKE_DOCKER_PLATFORM: "linux/arm64" }, /platform linux\/arm64, publish pushes linux\/amd64/],
    ["a missing source label", { FAKE_DOCKER_DROP_LABEL: "org.opencontainers.image.source" }, /label org\.opencontainers\.image\.source/],
    [
      "another revision label",
      { FAKE_DOCKER_SET_LABEL: `org.opencontainers.image.revision=${"0".repeat(40)}` },
      /label org\.opencontainers\.image\.revision is not 6ab0ef3/,
    ],
  ];
  for (const [what, env, message] of faults) {
    const bad = await simulate(t, PULL_REQUEST, { creds: GOOD }, { workflows: ["ci.yml"], env });
    const image = ciJob(bad, "image");
    assert.equal(image.status, "failure", `an image with ${what} must fail the pull-request image job`);
    assert.match(image.steps.at(-1)!.output, message, `${what}: ${bad.output}`);
    assert.equal(ciJob(bad, "ci-result").status, "failure", `${what}: the required ci-result check fails`);
  }
});

/** A pull-request workflow that reaches for each credential source the pull-request image job must never touch. */
const PROBE_WORKFLOW = `name: probe
on:
  pull_request:
permissions:
  contents: read
  id-token: write
jobs:
  oidc:
    runs-on: ubuntu-latest
    steps:
      - run: node -e 'fetch(process.env.ACTIONS_ID_TOKEN_REQUEST_URL + "&audience=openbao", { headers: { authorization: "Bearer " + process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN } }).then((r) => process.exit(r.ok ? 0 : 1))'
  openbao:
    runs-on: ubuntu-latest
    env:
      OPENBAO_ADDR: \${{ vars.OPENBAO_ADDR }}
    steps:
      - run: node -e 'fetch(process.env.OPENBAO_ADDR + "/v1/auth/jwt/login", { method: "POST", body: "{}" }).then((r) => process.exit(r.ok ? 0 : 1))'
  registry:
    runs-on: ubuntu-latest
    steps:
      - run: echo token | docker login ${REGISTRY} -u probe --password-stdin
  mount:
    runs-on: ubuntu-latest
    steps:
      - run: test -n "$(cat "$REGISTRY_PUSH_DIR/password")"
  secret:
    runs-on: ubuntu-latest
    env:
      TOKEN: \${{ secrets.ACR_PUSH_PASSWORD }}
    steps:
      - run: test -n "$TOKEN"
`;

test("pull-request runs never contact OpenBao, and ci-result needs the image job", async (t) => {
  // The tripwires work: each forbidden credential access from a pull request
  // fails the job that tries it and is recorded.
  const probeWs = mkdtempSync(join(tmpdir(), "probe-"));
  t.after(() => rmSync(probeWs, { recursive: true, force: true }));
  mkdirSync(join(probeWs, ".github", "workflows"), { recursive: true });
  writeFileSync(join(probeWs, ".github", "workflows", "probe.yml"), PROBE_WORKFLOW);
  const probe = await simulate(t, PULL_REQUEST, { creds: GOOD, tripwires: true }, { workspace: probeWs });
  assert.deepEqual(
    probe.jobs.map((j) => `${j.job} ${j.status}`),
    ["oidc failure", "openbao failure", "registry failure", "mount failure", "secret failure"],
    probe.output,
  );
  assert.deepEqual(
    [...probe.access].sort(),
    ["mount password", "oidc GET /oidc", "openbao POST /v1/auth/jwt/login", "registry login", "secret ACR_PUSH_PASSWORD"],
    "every forbidden access is recorded",
  );

  // Every workflow a pull request triggers, run whole under the same
  // tripwires: everything passes and no credential access was recorded.
  const pr = await simulate(t, PULL_REQUEST, { creds: GOOD, tripwires: true });
  assert.deepEqual(pr.jobs.filter((j) => j.workflow !== "ci.yml"), [], "only ci.yml runs for a pull request");
  assert.deepEqual(
    pr.jobs.map((j) => `${j.job} ${j.status}`),
    ["test success", "image success", "ci-result success"],
    pr.output,
  );
  assert.deepEqual(pr.access, [], "no OIDC, OpenBao, registry, runner-mount or secrets access");
  for (const j of pr.jobs) {
    assert.equal(j.oidcOffered, false, `${j.workflow}/${j.job} cannot mint an OIDC token`);
    assert.ok(!JSON.stringify(j.runsOn).includes("self-hosted"), `${j.workflow}/${j.job} stays off self-hosted runners`);
  }
  // The image job talks to docker only to build and inspect locally.
  assert.deepEqual(
    pr.calls.filter((c) => c.startsWith("docker ")).map((c) => c.split(" ").slice(0, 3).join(" ")),
    ["docker build -f", "docker image inspect"],
    pr.calls.join("\n"),
  );

  // ci-result needs the image job: it runs after it, and an image job that
  // fails fails ci-result, the strict required check on main.
  const bad = await simulate(t, PULL_REQUEST, { creds: GOOD, tripwires: true }, { env: { FAKE_DOCKER_PLATFORM: "linux/arm64" } });
  assert.deepEqual(
    bad.jobs.map((j) => `${j.job} ${j.status}`),
    ["test success", "image failure", "ci-result failure"],
    bad.output,
  );
  assert.match(ciJob(bad, "ci-result").steps.at(-1)!.output, /a required job ended 'failure'/);
  assert.deepEqual(bad.access, [], "a failing image job still makes no credential access");
  const ci = jobsOf("ci.yml");
  assert.ok((ci["ci-result"]!.needs as string[]).includes("image"), "ci-result needs image");
  const protection = JSON.parse(readFileSync(resolve(repoRoot, "devops", "github", "branch-protection.json"), "utf8")) as {
    required_status_checks: { strict: boolean; contexts: string[] };
  };
  assert.equal(protection.required_status_checks.strict, true, "main's protection stays strict");
  assert.ok(protection.required_status_checks.contexts.includes("ci-result"), "ci-result stays the required check");
});

// CR-PUBLISH-CRED-PREFLIGHT acceptance: on a push to main, publish.yml runs
// .github/scripts/estate-registry-credential.mjs against the real OIDC
// endpoint, OpenBao and registry as a preflight before the image build, so
// the merge itself is the proof that the estate credential path is live, and
// a dead endpoint fails the run, naming the step, before a build is spent.
// Pull requests run the same script only against stand-ins
// (tests/ci/registry-credential.test.ts, under the pull-request `npm test`);
// that proves the protocol, not reachability, and no pull-request job runs it
// against the real endpoints (CRANK-219: that would cross the trust boundary
// the tripwire test above enforces).
const CREDENTIAL_SCRIPT = ".github/scripts/estate-registry-credential.mjs";

test("publish.yml on main runs the credential preflight before the image build, and no pull-request job runs it against real endpoints", async (t) => {
  type Step = { name?: string; uses?: string; run?: string; if?: string; env?: Record<string, string> };
  const steps = (jobsOf("publish.yml").image as { steps: Step[] }).steps;
  const at = (pred: (s: Step) => boolean, what: string): number => {
    const i = steps.findIndex(pred);
    assert.ok(i >= 0, `publish.yml/image has ${what}`);
    return i;
  };
  const setup = at((s) => String(s.uses ?? "").startsWith("actions/setup-node@"), "a setup-node step");
  const preflight = at((s) => s.name === "Registry credential preflight", "a Registry credential preflight step");
  const build = at((s) => s.name === "Build", "a Build step");
  const publish = at((s) => s.name === "Publish", "a Publish step");
  assert.ok(setup < preflight && preflight < build && build < publish, "setup-node, then the preflight, then Build, then Publish");
  assert.ok(steps[preflight]!.run!.includes(`node ${CREDENTIAL_SCRIPT}`), "the preflight runs the credential script");
  assert.equal(steps[preflight]!.env?.OPENBAO_ADDR, "${{ vars.OPENBAO_ADDR }}", "against the real OpenBao the repository variable names");
  assert.deepEqual(
    steps.filter((s) => (s.run ?? "").includes(CREDENTIAL_SCRIPT)).map((s) => s.name),
    ["Registry credential preflight"],
    "the credential script runs once per publish, as the preflight",
  );

  // Run as written on a push to main: the credential is fetched and docker
  // logged in before anything is built; the build and push follow.
  const ok = await simulate(t, PUSH_MAIN, { creds: GOOD }, { workflows: ["publish.yml"] });
  const job = publishJob(ok);
  assert.equal(job.status, "success", ok.output);
  assert.deepEqual(job.steps.map((s) => `${s.name} ${s.status}`).slice(preflight, publish + 1), [
    "Registry credential preflight success",
    "Build success",
    "Publish success",
  ]);
  assert.deepEqual(ok.calls.map((c) => c.split(" ").slice(0, 2).join(" ")), ["docker login", "docker build", "docker push", "docker logout"]);
  for (const s of ["oidc", "openbao-login", "openbao-read", "registry-login"]) {
    assert.match(job.steps[preflight]!.output, new RegExp(`step ${s}: ok`), "the preflight log shows each step reached");
  }

  // OpenBao unreachable from the runner: the preflight fails naming the
  // step, the image is never built and nothing is pushed.
  const gone = createServer();
  await new Promise<void>((done) => gone.listen(0, "127.0.0.1", done));
  const deadAddr = `http://127.0.0.1:${(gone.address() as AddressInfo).port}`;
  await new Promise<void>((done) => gone.close(() => done()));
  const down = await simulate(t, PUSH_MAIN, { creds: GOOD }, { workflows: ["publish.yml"], openbaoAddr: deadAddr });
  const downJob = publishJob(down);
  assert.equal(downJob.status, "failure", "an unreachable OpenBao fails the publish run");
  assert.equal(downJob.steps[preflight]!.status, "failure");
  assert.match(downJob.steps[preflight]!.output, /step openbao-login \(OpenBao auth\/jwt\/login .*\): could not be reached/, down.output);
  assert.equal(downJob.steps[build]!.status, "skipped", "no build is spent after a failed preflight");
  assert.equal(downJob.steps[publish]!.status, "skipped");
  assert.deepEqual(down.calls.filter((c) => /^docker (build|login|push) /.test(c)), [], "nothing built, logged in to or pushed");

  // Pull requests: no job any workflow runs for a pull request runs the
  // credential script or is given the OpenBao address or an OIDC token. The
  // only pull-request use of the script is the stand-in test under `npm
  // test`, which addresses loopback stand-ins only and reads no endpoint or
  // credential from the environment.
  for (const file of readdirSync(workflowsDir).filter((f) => /\.ya?ml$/.test(f))) {
    const wf = readWorkflow(resolve(workflowsDir, file));
    if (!triggers(wf, PULL_REQUEST)) continue;
    const text = readFileSync(resolve(workflowsDir, file), "utf8");
    assert.ok(!text.includes("estate-registry-credential"), `${file} (pull request) does not run the credential script`);
    assert.ok(!text.includes("OPENBAO_ADDR"), `${file} (pull request) is not given the OpenBao address`);
  }
  const pr = await simulate(t, PULL_REQUEST, { creds: GOOD, tripwires: true });
  assert.ok(pr.jobs.every((j) => !j.oidcOffered), "no pull-request job can mint an OIDC token");
  assert.deepEqual(pr.requests, [], "no pull-request job reaches the OIDC endpoint or OpenBao");
  assert.deepEqual(pr.calls.filter((c) => /^docker (login|push|pull) /.test(c)), [], "no pull-request job logs in to the registry");
  const standIns = readFileSync(resolve(repoRoot, "tests", "ci", "registry-credential.test.ts"), "utf8");
  assert.doesNotMatch(standIns, /azurecr\.io/, "the stand-in test names no real registry");
  assert.doesNotMatch(standIns, /process\.env\.(?!(?:PATH|DOCKER_CONFIG)\b)\w+/, "the stand-in test takes no endpoint or credential from the environment");
  assert.doesNotMatch(standIns, /\bproves? (?:live )?reachability|live reachability is proven/i, "the stand-in test does not claim to prove reachability");
});
