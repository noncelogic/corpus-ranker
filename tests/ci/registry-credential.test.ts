// CR-PUBLISH-CRED-PREFLIGHT acceptance (INTENTS I25; Rule:
// policies/placement-defaults.yaml#credentials): .github/scripts/
// estate-registry-credential.mjs, the one script publish.yml runs on main to
// fetch the ranker's ACR push credential, is run here as written against
// stand-in endpoints:
//
//   - a stand-in GitHub OIDC token endpoint (ACTIONS_ID_TOKEN_REQUEST_URL);
//   - a stand-in OpenBao (OPENBAO_ADDR): auth/jwt/login with role
//     corpus-ranker-registry-push, then kv/data/corpus-ranker/acr-push;
//   - a stand-in registry: a local HTTP server answering the registry API's
//     GET /v2/ with basic auth, reached by a stand-in `docker login` that
//     carries out the login against it (docker treats 127.0.0.0/8 registries
//     as insecure, so plain HTTP is what the real CLI would use there too).
//
// This runs in the pull-request `npm test` and holds no production
// credential: every address, token and password below is made up, and the
// stand-ins only accept those. It proves the script's protocol and that a
// failure names the step that could not be reached. It is NOT proof that the
// real OIDC endpoint, OpenBao or the estate registry are reachable: that
// proof is the credential preflight publish.yml runs against the real
// endpoints on every push to main, before the image build
// (tests/ci/publish-workflow.test.ts). Pull-request code never reaches the
// production credential (CRANK-219: production reachability from a pull
// request would cross the trust boundary that test enforces).
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTcpServer, type AddressInfo, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = resolve(repoRoot, ".github", "scripts", "estate-registry-credential.mjs");

const ROLE = "corpus-ranker-registry-push";
const SECRET = "/v1/kv/data/corpus-ranker/acr-push";
const OIDC_REQUEST_TOKEN = "standin-request-" + "R".repeat(24);
const OIDC_JWT = "eyJstandin" + "J".repeat(40);
const BAO_TOKEN = "hvs.standin" + "B".repeat(30);
const USERNAME = "corpus-ranker-push";
const PASSWORD = "standin-acr-" + "P".repeat(30);

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

const send = (res: ServerResponse, status: number, json: unknown): void => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(json));
};

/** A local HTTP stand-in; every request is recorded as "<name> <METHOD> <path>". */
async function standIn(t: TestContext, name: string, log: string[], handle: Handler): Promise<string> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      log.push(`${name} ${req.method} ${new URL(req.url ?? "/", "http://x").pathname}`);
      handle(req, res, body);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * An unreachable endpoint that stays bound for the whole scenario: a local TCP
 * listener that destroys every connection it accepts, so no other listener can
 * take the port between choosing it and the request. The caller closes it,
 * awaited, once the child process has completed.
 */
async function droppingListener(): Promise<{ addr: string; server: Server }> {
  const server = createTcpServer((socket) => socket.destroy());
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return { addr: `127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

const closeServer = (server: Server): Promise<void> => new Promise((done) => server.close(() => done()));

interface Down {
  oidc?: boolean;
  openbao?: boolean;
  /** OpenBao accepts the login but drops the connection on the secret read. */
  openbaoRead?: boolean;
  registry?: boolean;
}

/**
 * Transient faults: how many times each endpoint answers HTTP 503 before it
 * answers normally (the registry's 503 makes the stand-in docker login exit 1).
 * `openbaoReadHang` holds the secret read open without answering that many times.
 */
interface Flaky {
  openbaoLogin?: number;
  openbaoRead?: number;
  openbaoReadHang?: number;
  registry?: number;
}

interface Options {
  down?: Down;
  flaky?: Flaky;
  env?: Record<string, string>;
  /** Extra node flags for the script's process (e.g. --import of a recording preload). */
  nodeArgs?: string[];
}

interface Run {
  code: number | null;
  stderr: string;
  stdout: string;
  requests: string[];
  dockerCalls: string[];
  /** What the stand-in docker stored in DOCKER_CONFIG after a login. */
  dockerConfig?: string;
}

async function runScript(t: TestContext, opts: Options = {}): Promise<Run> {
  const { down = {}, flaky = {}, env = {}, nodeArgs = [] } = opts;
  const requests: string[] = [];
  const seen: Record<string, number> = {};
  /** True while `key` is still inside its injected transient-fault count. */
  const faulty = (key: keyof Flaky): boolean => (seen[key] = (seen[key] ?? 0) + 1) <= (flaky[key] ?? 0);
  const oidc = await standIn(t, "oidc", requests, (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (req.headers.authorization !== `Bearer ${OIDC_REQUEST_TOKEN}`) return send(res, 401, {});
    if (url.searchParams.get("audience") !== "openbao") return send(res, 200, { value: "jwt-for-another-audience" });
    send(res, 200, { value: OIDC_JWT });
  });
  const openbao = await standIn(t, "openbao", requests, (req, res, body) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method === "POST" && path === "/v1/auth/jwt/login") {
      if (faulty("openbaoLogin")) return send(res, 503, { errors: ["sealed"] });
      const { role, jwt } = JSON.parse(body || "{}") as { role?: string; jwt?: string };
      if (role !== ROLE || jwt !== OIDC_JWT) return send(res, 403, { errors: ["permission denied"] });
      return send(res, 200, { auth: { client_token: BAO_TOKEN } });
    }
    if (req.method === "GET" && path === SECRET) {
      if (down.openbaoRead) return req.socket.destroy();
      if (faulty("openbaoReadHang")) return; // never answered
      if (faulty("openbaoRead")) return send(res, 503, { errors: ["standby"] });
      if (req.headers["x-vault-token"] !== BAO_TOKEN) return send(res, 403, { errors: ["permission denied"] });
      return send(res, 200, { data: { data: { registry, username: USERNAME, password: PASSWORD }, metadata: { version: 1 } } });
    }
    if (req.method === "POST" && path === "/v1/auth/token/revoke-self") return send(res, 204, {});
    send(res, 404, { errors: [] });
  });
  const basic = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")}`;
  let registry = await standIn(t, "registry", requests, (req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (req.method !== "GET" || path !== "/v2/") return send(res, 404, {});
    if (faulty("registry")) return send(res, 503, { errors: [{ code: "UNAVAILABLE" }] });
    if (req.headers.authorization !== basic) {
      res.setHeader("WWW-Authenticate", 'Basic realm="standin"');
      return send(res, 401, { errors: [{ code: "UNAUTHORIZED" }] });
    }
    send(res, 200, {});
  });
  // The OpenBao secret names this registry, and EXPECTED_REGISTRY matches it;
  // a down registry is an address whose listener drops every connection.
  const dropping: Server[] = [];
  const unreachable = async (): Promise<string> => {
    const { addr, server } = await droppingListener();
    dropping.push(server);
    return addr;
  };
  if (down.registry) registry = await unreachable();

  const dir = mkdtempSync(join(tmpdir(), "regcred-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, "bin");
  const dockerConfig = join(dir, "docker-config");
  mkdirSync(bin);
  mkdirSync(dockerConfig);
  // Stand-in docker CLI: `docker login <host> -u <user> --password-stdin`
  // logs in against the stand-in registry the way the CLI does (GET /v2/
  // with basic auth) and stores the auth in DOCKER_CONFIG; it prints the
  // daemon-style error when the registry cannot be reached or refuses.
  const login = `
const [host, user] = [process.argv[2], process.argv[3]];
let password = "";
process.stdin.on("data", (c) => (password += c));
process.stdin.on("end", async () => {
  let res;
  try {
    res = await fetch("http://" + host + "/v2/", { headers: { authorization: "Basic " + Buffer.from(user + ":" + password).toString("base64") } });
  } catch (err) {
    console.error("Error response from daemon: Get \\"http://" + host + "/v2/\\": dial tcp " + host + ": connect: connection refused");
    process.exit(1);
  }
  if (res.status !== 200) {
    console.error("Error response from daemon: login attempt to http://" + host + "/v2/ failed with status: " + res.status);
    process.exit(1);
  }
  require("node:fs").writeFileSync(process.env.DOCKER_CONFIG + "/config.json", JSON.stringify({ auths: { [host]: { auth: Buffer.from(user + ":" + password).toString("base64") } } }));
  console.log("Login Succeeded");
});`;
  writeFileSync(join(dir, "login.cjs"), login);
  writeFileSync(
    join(bin, "docker"),
    `#!/bin/bash\necho "docker $*" >> "${dir}/calls"\n` +
      `if [ "$1" = login ] && [ "$3" = -u ] && [ "$5" = --password-stdin ]; then exec "${process.execPath}" "${dir}/login.cjs" "$2" "$4"; fi\n` +
      `echo "stand-in docker: unexpected $*" >&2; exit 2\n`,
  );
  chmodSync(join(bin, "docker"), 0o755);

  const oidcAddr = down.oidc ? await unreachable() : oidc;
  const baoAddr = down.openbao ? await unreachable() : openbao;
  const child = spawn(process.execPath, [...nodeArgs, SCRIPT], {
    cwd: repoRoot,
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      DOCKER_CONFIG: dockerConfig,
      ACTIONS_ID_TOKEN_REQUEST_URL: `http://${oidcAddr}/oidc?api-version=2.0`,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: OIDC_REQUEST_TOKEN,
      OPENBAO_ADDR: `http://${baoAddr}`,
      EXPECTED_REGISTRY: registry,
      // Short backoff between attempts so the stand-in runs stay fast; the
      // attempt bound and the 30-second HTTP bound are the script's own.
      PUBLISH_RETRY_BACKOFF_MS: "10",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
  let code: number | null;
  try {
    [code] = (await once(child, "close")) as [number | null];
  } finally {
    await Promise.all(dropping.map(closeServer));
  }
  const read = (f: string): string | undefined => {
    try {
      return readFileSync(f, "utf8");
    } catch {
      return undefined;
    }
  };
  return {
    code,
    stdout,
    stderr,
    requests,
    dockerCalls: (read(join(dir, "calls")) ?? "").trim().split("\n").filter(Boolean),
    dockerConfig: read(join(dockerConfig, "config.json")),
  };
}

const assertNoSecretPrinted = (run: Run): void => {
  for (const secret of [OIDC_REQUEST_TOKEN, OIDC_JWT, BAO_TOKEN, PASSWORD]) {
    assert.ok(!run.stdout.includes(secret) && !run.stderr.includes(secret), "no token or password is printed");
    assert.ok(!run.dockerCalls.join(" ").includes(secret), "no token or password goes on argv");
  }
};

test("the credential script logs in against stand-in OIDC, OpenBao and registry endpoints, and names the unreachable step when one fails", async (t) => {
  // Every stand-in up: OIDC (audience openbao) -> OpenBao JWT login with the
  // bound role -> read the push credential -> docker login against the
  // registry, password on stdin -> revoke the OpenBao token.
  const ok = await runScript(t);
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(ok.requests, [
    "oidc GET /oidc",
    "openbao POST /v1/auth/jwt/login",
    `openbao GET ${SECRET}`,
    "registry GET /v2/",
    "openbao POST /v1/auth/token/revoke-self",
  ]);
  assert.equal(ok.dockerCalls.length, 1, ok.dockerCalls.join("\n"));
  assert.match(ok.dockerCalls[0]!, new RegExp(`^docker login 127\\.0\\.0\\.1:\\d+ -u ${USERNAME} --password-stdin$`));
  assert.ok(ok.dockerConfig, "the registry login is stored in the job's DOCKER_CONFIG");
  // Each step reports that it was reached, by name, so a preflight log shows how far it got.
  for (const step of ["oidc", "openbao-login", "openbao-read", "registry-login"]) {
    assert.match(ok.stderr, new RegExp(`step ${step}: ok`), `step ${step} is reported: ${ok.stderr}`);
  }
  assertNoSecretPrinted(ok);

  // One endpoint down at a time: the script fails, names the step that could
  // not be reached, and attempts nothing after it.
  const cases: Array<[keyof Down, string, RegExp, string[]]> = [
    ["oidc", "oidc", /GitHub OIDC token endpoint/, []],
    ["openbao", "openbao-login", /OpenBao auth\/jwt\/login/, ["oidc GET /oidc"]],
    // A dropped connection is transient, so the read is attempted up to the bound (3) before failing.
    ["openbaoRead", "openbao-read", /OpenBao kv\/data\/corpus-ranker\/acr-push/, ["oidc GET /oidc", "openbao POST /v1/auth/jwt/login", ...Array(3).fill(`openbao GET ${SECRET}`)]],
    ["registry", "registry-login", /docker login 127\.0\.0\.1:\d+/, ["oidc GET /oidc", "openbao POST /v1/auth/jwt/login", `openbao GET ${SECRET}`]],
  ];
  for (const [down, step, what, before] of cases) {
    const run = await runScript(t, { down: { [down]: true } });
    assert.equal(run.code, 1, `${down} down must fail the script: ${run.stderr}`);
    const last = run.stderr.trim().split("\n").at(-1)!;
    assert.match(last, new RegExp(`^estate-registry-credential: step ${step} \\(`), `${down} down: the failure names step ${step}: ${run.stderr}`);
    assert.match(last, what, `${down} down: the failure says which endpoint: ${last}`);
    // An endpoint the script calls itself is "could not be reached"; the
    // registry is reached by docker login, whose own error is shown above.
    assert.match(last, down === "registry" ? /failed: docker login exited 1/ : /could not be reached \(/, last);
    if (down === "registry") assert.match(run.stderr, /connection refused/, "docker's own reason is shown");
    // Nothing past the failed step is attempted (revocation aside, which follows any login).
    assert.deepEqual(
      run.requests.filter((r) => !r.endsWith("revoke-self")),
      before,
      `${down} down: no step after ${step} runs`,
    );
    if (down !== "registry") assert.deepEqual(run.dockerCalls, [], `${down} down: no docker login`);
    assert.equal(run.dockerConfig, undefined, `${down} down: no registry login is stored`);
    assertNoSecretPrinted(run);
  }

  // Incomplete configuration also names its step, before anything is contacted.
  const noAddr = await runScript(t, { env: { OPENBAO_ADDR: "" } });
  assert.equal(noAddr.code, 1);
  assert.match(noAddr.stderr, /step openbao-login \(.*\): OPENBAO_ADDR is not set/, noAddr.stderr);
  assert.deepEqual(noAddr.requests, [], "nothing is contacted when the configuration is incomplete");
});

// CR-PUBLISH-RETRY acceptance (CRANK-219 tripwire: bounded transient-failure
// retries and timeouts, keeping the 30-second HTTP bound). Each external
// call the script makes (OIDC, OpenBao login, OpenBao read, docker login) is
// retried with backoff up to 3 attempts inside an overall deadline; a
// transient fault (unreachable, timed out, HTTP 408/429/5xx, docker login
// failing) is retried, a refusal (other 4xx) is not.
const ATTEMPTS = 3;

test("a transient OpenBao or registry failure is retried within the bound and then succeeds", async (t) => {
  for (const [flaky, step, request] of [
    [{ openbaoLogin: 2 }, "openbao-login", "openbao POST /v1/auth/jwt/login"],
    [{ openbaoRead: 1 }, "openbao-read", `openbao GET ${SECRET}`],
    [{ registry: 2 }, "registry-login", "registry GET /v2/"],
  ] as Array<[Flaky, string, string]>) {
    const failures = Object.values(flaky)[0]!;
    const run = await runScript(t, { flaky });
    assert.equal(run.code, 0, `${step}: ${failures} transient failure(s) are retried and the login succeeds: ${run.stderr}`);
    assert.equal(run.requests.filter((r) => r === request).length, failures + 1, `${step}: one attempt per failure plus the one that succeeds`);
    for (let n = 1; n <= failures; n++) {
      assert.match(run.stderr, new RegExp(`step ${step}: attempt ${n} of ${ATTEMPTS} failed .*; retrying in \\d+ ms`), run.stderr);
    }
    assert.doesNotMatch(run.stderr, new RegExp(`step ${step}: attempt ${failures + 1} of`), "no attempt after the one that succeeds");
    for (const s of ["oidc", "openbao-login", "openbao-read", "registry-login"]) assert.match(run.stderr, new RegExp(`step ${s}: ok`));
    if (step === "registry-login") assert.equal(run.dockerCalls.length, failures + 1, "docker login is re-run per attempt");
    assert.ok(run.dockerConfig, `${step}: the registry login is stored`);
    assertNoSecretPrinted(run);
  }
});

test("a failure that persists past the retry bound exits non-zero naming the operation and attempts, and each HTTP call stays bounded at 30 seconds", async (t) => {
  // Persisting 503s: exactly ATTEMPTS attempts, then exit 1 with one line
  // naming the step (the operation) and the attempts made; nothing after it runs.
  for (const [flaky, step, request] of [
    [{ openbaoLogin: 99 }, "openbao-login", "openbao POST /v1/auth/jwt/login"],
    [{ openbaoRead: 99 }, "openbao-read", `openbao GET ${SECRET}`],
    [{ registry: 99 }, "registry-login", "registry GET /v2/"],
  ] as Array<[Flaky, string, string]>) {
    const run = await runScript(t, { flaky });
    assert.equal(run.code, 1, `${step}: a persisting failure fails the script: ${run.stderr}`);
    assert.equal(run.requests.filter((r) => r === request).length, ATTEMPTS, `${step}: attempted exactly ${ATTEMPTS} times`);
    const last = run.stderr.trim().split("\n").at(-1)!;
    assert.match(last, new RegExp(`^estate-registry-credential: step ${step} \\(.*\\): .*; gave up after ${ATTEMPTS} attempts`), last);
    assert.match(last, step === "registry-login" ? /docker login exited 1/ : /HTTP 503/, last);
    if (step !== "registry-login") assert.ok(!run.requests.includes("registry GET /v2/"), "no registry login after a failed OpenBao step");
    assert.equal(run.dockerConfig, undefined);
    assertNoSecretPrinted(run);
  }

  // A refusal is not transient: one attempt, and the failure says so.
  const refused = await runScript(t, { env: { ACTIONS_ID_TOKEN_REQUEST_TOKEN: "wrong" } });
  assert.equal(refused.code, 1);
  assert.deepEqual(refused.requests, ["oidc GET /oidc"], "a refusal (HTTP 401) is not retried");
  assert.match(refused.stderr.trim().split("\n").at(-1)!, /step oidc \(.*\): refused: HTTP 401; not retried \(1 attempt\)/);

  // The 30-second bound: a preload records the timeout every abort signal the
  // script asks for and scales it down 1000x, so a secret read that never
  // answers is cut off by that bound (30 ms here, 30 s in production) on
  // every attempt instead of waiting forever.
  const dir = mkdtempSync(join(tmpdir(), "regcred-timeout-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "timeouts");
  const preload = join(dir, "record-timeouts.mjs");
  writeFileSync(
    preload,
    `import { appendFileSync } from "node:fs";\n` +
      `const real = AbortSignal.timeout.bind(AbortSignal);\n` +
      `AbortSignal.timeout = (ms) => { appendFileSync(${JSON.stringify(log)}, ms + "\\n"); return real(Math.ceil(ms / 1000)); };\n`,
  );
  const hung = await runScript(t, { flaky: { openbaoReadHang: 99 }, nodeArgs: ["--import", pathToFileURL(preload).href] });
  assert.equal(hung.code, 1, hung.stderr);
  assert.equal(hung.requests.filter((r) => r === `openbao GET ${SECRET}`).length, ATTEMPTS);
  assert.match(hung.stderr.trim().split("\n").at(-1)!, new RegExp(`step openbao-read \\(.*\\): could not be reached \\(TimeoutError\\); gave up after ${ATTEMPTS} attempts`));
  const bounds = readFileSync(log, "utf8").trim().split("\n").map(Number);
  // oidc + login + 3 reads + revoke: every HTTP call carries the bound, and it is 30 seconds.
  assert.equal(bounds.length, 1 + 1 + ATTEMPTS + 1, `one bounded signal per HTTP call: ${bounds.join(",")}`);
  assert.deepEqual([...new Set(bounds)], [30_000], "each HTTP call is bounded at 30 seconds");
  // The docker login child is bounded at 30 seconds too (static: it is not an HTTP call the preload sees).
  assert.match(readFileSync(SCRIPT, "utf8"), /const TIMEOUT_MS = 30_000;/);
});
