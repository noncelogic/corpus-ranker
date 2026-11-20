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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readWorkflow, runEvent, type JobRun, type WorkflowEvent } from "./workflow-runner.ts";

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
  requests: string[];
  loginStdin?: string;
  output: string;
}

/**
 * Run the repository's workflows for `event` on the local runner. Stand-in
 * docker, npm and kustomize record their argv (and docker login's stdin). A
 * decoy of the old runner mount, holding a different credential, is offered
 * to every step as REGISTRY_PUSH_DIR: nothing may use it.
 */
async function simulate(
  t: TestContext,
  event: WorkflowEvent,
  estate: Estate,
  workflows?: string[],
  /** Extra host environment, e.g. the stand-in docker's FAKE_DOCKER_* faults. */
  extraEnv: Record<string, string> = {},
): Promise<Simulation> {
  const fake = await fakeEstate(t, estate);
  const dir = mkdtempSync(join(tmpdir(), "publish-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const decoy = join(dir, "registry-push");
  for (const d of [bin, decoy]) mkdirSync(d);
  writeFileSync(join(decoy, "registry"), `${REGISTRY}\n`);
  writeFileSync(join(decoy, "username"), "mounted-user\n");
  writeFileSync(join(decoy, "password"), "mounted-password\n");
  const dockerState = join(dir, "docker-state");
  mkdirSync(dockerState);
  for (const tool of ["docker", "npm", "kustomize"]) {
    writeFileSync(
      join(bin, tool),
      `#!/bin/bash\nargs="$*"; echo "${tool} \${args//$'\\n'/ }" >> "${dir}/calls"\n` +
        (tool === "docker"
          ? `case "$1" in login) cat > "${dir}/login-stdin" ;; esac\nDOCKER_STATE="${dockerState}"\n. "${FAKE_DOCKER}" "$@"\n`
          : "") +
        "exit 0\n",
    );
    chmodSync(join(bin, tool), 0o755);
  }

  const jobs = await runEvent({
    workflowsDir,
    workflows,
    event,
    workspace: repoRoot,
    repository: "noncelogic/corpus-ranker",
    vars: { OPENBAO_ADDR: fake.url },
    hostEnv: { PATH: `${bin}:${process.env.PATH}`, HOME: dir, REGISTRY_PUSH_DIR: decoy, ...extraEnv },
    oidc: { url: `${fake.url}/oidc?api-version=2.0`, token: OIDC_REQUEST_TOKEN },
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
    requests: fake.requests,
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
  // login to the registry it names, password on stdin -> push the SHA tag ->
  // log out.
  const ok = await simulate(t, PUSH_MAIN, { creds: GOOD }, ["publish.yml"]);
  const job = publishJob(ok);
  assert.equal(job.status, "success", ok.output);
  assert.deepEqual(job.runsOn, ["self-hosted", "corpus-ranker-ci"], "runs-on stays [self-hosted, corpus-ranker-ci]");
  assert.deepEqual((job.runsOn as string[]).filter((l) => !RUNNER_LABELS.includes(l)), [], "every label is one the ranker's runner carries");
  assert.deepEqual(job.permissions, { contents: "read", "id-token": "write" }, "contents: read and id-token: write only; no packages");
  assert.ok(job.oidcOffered, "the job is granted id-token: write, so it can mint the OIDC token");
  assert.deepEqual(ok.requests, ["GET /oidc", "POST /v1/auth/jwt/login", `GET ${SECRET}`, "POST /v1/auth/token/revoke-self"]);
  assert.equal(ok.calls.length, 4, ok.calls.join("\n"));
  assert.match(ok.calls[0]!, new RegExp(`^docker build .* -t ${IMAGE}:sha-${SHA} \\.$`), "builds the SHA-tagged image");
  assert.deepEqual(ok.calls.slice(1), [
    `docker login ${REGISTRY} -u corpus-ranker-push --password-stdin`,
    `docker push ${IMAGE}:sha-${SHA}`,
    `docker logout ${REGISTRY}`,
  ]);
  assert.equal(ok.loginStdin, PASSWORD, "the fetched password reaches docker login on stdin");
  assert.doesNotMatch(ok.calls.join(" "), /mounted-/, "nothing from the runner mount is used");
  for (const secret of [PASSWORD, BAO_TOKEN, OIDC_JWT, OIDC_REQUEST_TOKEN]) {
    assert.ok(!ok.calls.join(" ").includes(secret), "no token or password goes on argv");
    assert.ok(!ok.output.includes(secret), "no token or password is printed");
  }

  // OpenBao refuses the login (e.g. the role's bound claims do not match):
  // the job fails, no secret is read, nothing is logged in to or pushed.
  const refused = await simulate(t, PUSH_MAIN, { creds: GOOD, refuseLogin: true }, ["publish.yml"]);
  assert.equal(publishJob(refused).status, "failure", "a login OpenBao refuses must fail the job");
  assert.deepEqual(refused.requests, ["GET /oidc", "POST /v1/auth/jwt/login"]);
  assert.deepEqual(refused.calls.filter((c) => !/^docker (build|logout) /.test(c)), [], "nothing is logged in to or pushed without the OpenBao credential");
  assert.ok(!refused.output.includes(OIDC_JWT), "the OIDC token is not printed on refusal");

  // A credential for another registry is refused before any login or push.
  const wrong = await simulate(t, PUSH_MAIN, { creds: { registry: "ghcr.io", username: "u", password: PASSWORD } }, ["publish.yml"]);
  assert.equal(publishJob(wrong).status, "failure", "a push credential for another registry must fail the job");
  assert.deepEqual(wrong.calls.filter((c) => !/^docker (build|logout) /.test(c)), [], "nothing is logged in to or pushed with a mismatched credential");
  assert.ok(!wrong.output.includes(PASSWORD), "the password is not printed on refusal");
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

test("ci.yml's image job declares DRY_RUN_OF image and builds from the same build inputs as publish.yml's image job", async (t) => {
  const ci = jobsOf("ci.yml");
  const publish = jobsOf("publish.yml");
  assert.deepEqual(ci.image?.env, { DRY_RUN_OF: "image" }, "ci.yml's image job declares DRY_RUN_OF: image");
  assert.ok(publish[String((ci.image!.env as Record<string, string>).DRY_RUN_OF)], "DRY_RUN_OF names publish.yml's image job");

  // One shared definition: neither workflow spells out its own docker build.
  for (const file of ["ci.yml", "publish.yml"]) {
    const source = readFileSync(resolve(workflowsDir, file), "utf8");
    assert.doesNotMatch(source, /docker\s+(buildx\s+)?build/, `${file} builds only through .github/scripts/image-build.sh`);
    assert.match(source, /\. \.github\/scripts\/image-build\.sh/, `${file} sources the shared build definition`);
  }

  // Run as written: the pull request's build and main's publish build pass
  // docker the same Dockerfile, context, platform, build arguments and
  // labels; only the tag differs.
  const pr = await simulate(t, PULL_REQUEST, { creds: GOOD }, ["ci.yml"]);
  const main = await simulate(t, PUSH_MAIN, { creds: GOOD }, ["publish.yml"]);
  assert.equal(builds(pr).length, 1, pr.calls.join("\n"));
  assert.equal(builds(main).length, 1, main.calls.join("\n"));
  const expected = `docker build -f Dockerfile --platform linux/amd64 ${LABELS.map((l) => `--label ${l}`).join(" ")} -t <tag> .`;
  assert.equal(builds(pr)[0]!.replace(` -t ${PR_TAG} `, " -t <tag> "), expected, "the pull request builds from the shared inputs");
  assert.equal(builds(main)[0]!.replace(` -t ${PUBLISH_TAG} `, " -t <tag> "), expected, "publish builds from the shared inputs");
  assert.equal(ciJob(pr, "image").status, "success", pr.output);
});

test("the pull-request image job fails when the built image's manifest or metadata labels differ from what publish pushes", async (t) => {
  // The build as defined passes the check, and the check really reads the built image.
  const ok = await simulate(t, PULL_REQUEST, { creds: GOOD }, ["ci.yml"]);
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
    const bad = await simulate(t, PULL_REQUEST, { creds: GOOD }, ["ci.yml"], env);
    const image = ciJob(bad, "image");
    assert.equal(image.status, "failure", `an image with ${what} must fail the pull-request image job`);
    assert.match(image.steps.at(-1)!.output, message, `${what}: ${bad.output}`);
    assert.equal(ciJob(bad, "ci-result").status, "failure", `${what}: the required ci-result check fails`);
  }
});

test("pull-request runs never contact OpenBao, and ci-result needs the image job", async (t) => {
  const pr = await simulate(t, PULL_REQUEST, { creds: GOOD });
  assert.deepEqual(pr.jobs.filter((j) => j.workflow !== "ci.yml"), [], "only ci.yml runs for a pull request");
  assert.deepEqual(pr.requests, [], "no OIDC token endpoint or OpenBao request");
  for (const j of pr.jobs) {
    assert.equal(j.oidcOffered, false, `${j.workflow}/${j.job} cannot mint an OIDC token`);
    assert.ok(!JSON.stringify(j.runsOn).includes("self-hosted"), `${j.workflow}/${j.job} stays off self-hosted runners`);
  }
  // The image job talks to docker only to build and inspect locally: no
  // registry login, push or pull, and nothing from the runner mount decoy.
  assert.deepEqual(
    pr.calls.filter((c) => c.startsWith("docker ")).map((c) => c.split(" ").slice(0, 3).join(" ")),
    ["docker build -f", "docker image inspect"],
    pr.calls.join("\n"),
  );
  assert.doesNotMatch(pr.calls.join("\n") + pr.output, /mounted-/, "no runner-mounted credential is restored");
  // What ci.yml declares and runs (comments aside) names no credential source.
  const ciSource = readFileSync(resolve(workflowsDir, "ci.yml"), "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
  for (const forbidden of [/OPENBAO/, /id-token/, /estate-registry-credential/, /REGISTRY_PUSH_DIR|\/etc\/registry-push/, /secrets\./]) {
    assert.doesNotMatch(ciSource, forbidden, `ci.yml references ${forbidden}`);
  }

  // ci-result needs the image job and is the strict required check on main.
  const ci = jobsOf("ci.yml");
  assert.ok((ci["ci-result"]!.needs as string[]).includes("image"), "ci-result needs image");
  const protection = JSON.parse(readFileSync(resolve(repoRoot, "devops", "github", "branch-protection.json"), "utf8")) as {
    required_status_checks: { strict: boolean; contexts: string[] };
  };
  assert.equal(protection.required_status_checks.strict, true, "main's protection stays strict");
  assert.ok(protection.required_status_checks.contexts.includes("ci-result"), "ci-result stays the required check");
  assert.equal(ciJob(pr, "ci-result").status, "success", pr.output);
});
