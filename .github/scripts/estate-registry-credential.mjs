// Fetches the ranker's ACR push credential for this one publish run and logs
// docker in with it (INTENTS I25; policy ci-job-definitions). Shape follows
// noncelogic/loop-closer .github/scripts/estate-registry-credential.mjs.
//
//   1. Mint a GitHub OIDC token with audience `openbao` (needs the job's
//      `id-token: write`).
//   2. Log in to OpenBao at auth/jwt with role corpus-ranker-registry-push,
//      which is bound to this repository, refs/heads/main, push events and
//      publish.yml on main.
//   3. Read kv/data/corpus-ranker/acr-push (registry, username, password).
//   4. Refuse a credential for any registry other than EXPECTED_REGISTRY, then
//      `docker login <registry> -u <username> --password-stdin`.
//   5. Revoke the OpenBao token.
//
// Nothing secret is printed, put on argv or written to disk by this script:
// the OIDC token, the OpenBao token and the password only travel in request
// bodies/headers and on docker's stdin. Docker writes its auth to
// DOCKER_CONFIG, which the calling step points at a per-run directory.
// No dependencies; Node's fetch trusts the estate CA through NODE_EXTRA_CA_CERTS.
//
// Each step is named (oidc, openbao-login, openbao-read, registry-login) and
// reported on stderr as it completes; a failure ends with one line naming
// the step and the endpoint that could not be reached or refused. publish.yml
// runs this as the credential preflight on every push to main, before the
// image build, so a red preflight says which estate endpoint is down. Pull
// requests run it only against stand-ins (tests/ci/registry-credential.test.ts),
// which proves the protocol, not live reachability.
import { spawn } from "node:child_process";

const ROLE = "corpus-ranker-registry-push";
const AUDIENCE = "openbao";
const SECRET_PATH = "kv/data/corpus-ranker/acr-push";
const TIMEOUT_MS = 30_000;

/** A failure of one named step; the message is printed as-is, so it never carries a body or a secret. */
class StepError extends Error {}

/** One step of the login: `what` names the endpoint it contacts (no secrets). */
function step(id, what) {
  const fail = (reason) => new StepError(`step ${id} (${what}): ${reason}`);
  return {
    fail,
    ok: () => console.error(`estate-registry-credential: step ${id}: ok`),
    /** fetch + JSON, with a bounded wait; an unreachable endpoint and a refusal read differently. */
    async getJson(url, init) {
      let res;
      try {
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      } catch (err) {
        throw fail(`could not be reached (${err?.cause?.code ?? err?.cause?.message ?? err?.name ?? "error"})`);
      }
      if (!res.ok) throw fail(`refused: HTTP ${res.status}`);
      try {
        return await res.json();
      } catch {
        throw fail("response is not JSON");
      }
    },
  };
}

function need(s, name) {
  const value = process.env[name];
  if (!value) throw s.fail(`${name} is not set`);
  return value;
}

function dockerLogin(s, registry, username, password) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["login", registry, "-u", username, "--password-stdin"], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", (err) => reject(s.fail(`could not run docker (${err.code ?? err.message})`)));
    child.on("close", (code) => (code === 0 ? resolve() : reject(s.fail(`failed: docker login exited ${code}`))));
    child.stdin.end(password);
  });
}

async function main() {
  const oidcStep = step("oidc", "GitHub OIDC token endpoint");
  const requestUrl = need(oidcStep, "ACTIONS_ID_TOKEN_REQUEST_URL");
  const requestToken = need(oidcStep, "ACTIONS_ID_TOKEN_REQUEST_TOKEN");
  const loginStep = step("openbao-login", `OpenBao auth/jwt/login role ${ROLE} at ${process.env.OPENBAO_ADDR || "<unset>"}`);
  const bao = need(loginStep, "OPENBAO_ADDR").replace(/\/+$/, "");
  const expected = need(step("registry-login", "docker login"), "EXPECTED_REGISTRY");
  let oidcUrl;
  try {
    oidcUrl = new URL(requestUrl);
  } catch {
    throw oidcStep.fail("ACTIONS_ID_TOKEN_REQUEST_URL is not a URL");
  }

  // 1. GitHub OIDC token, audience openbao. Only the origin is named: the
  // request URL's query is GitHub's to keep.
  const oidcAt = step("oidc", `GitHub OIDC token endpoint ${oidcUrl.origin}`);
  oidcUrl.searchParams.set("audience", AUDIENCE);
  const oidc = await oidcAt.getJson(oidcUrl, { headers: { Authorization: `Bearer ${requestToken}` } });
  if (typeof oidc?.value !== "string" || oidc.value === "") throw oidcAt.fail("no token value");
  oidcAt.ok();

  // 2. OpenBao JWT login with the bound role.
  const login = await loginStep.getJson(`${bao}/v1/auth/jwt/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: ROLE, jwt: oidc.value }),
  });
  const baoToken = login?.auth?.client_token;
  if (typeof baoToken !== "string" || baoToken === "") throw loginStep.fail("no client token");
  loginStep.ok();

  try {
    // 3. Read the push credential.
    const readStep = step("openbao-read", `OpenBao ${SECRET_PATH} at ${bao}`);
    const secret = await readStep.getJson(`${bao}/v1/${SECRET_PATH}`, { headers: { "X-Vault-Token": baoToken } });
    const data = secret?.data?.data ?? {};
    const { registry, username, password } = data;
    for (const [key, value] of Object.entries({ registry, username, password })) {
      if (typeof value !== "string" || value.trim() === "") throw readStep.fail(`no ${key}`);
    }
    // The credential must be for the registry IMAGE names, or the push
    // would go nowhere (or somewhere else).
    if (registry.trim() !== expected) {
      throw readStep.fail(`push credential is for '${registry.trim()}', not ${expected}`);
    }
    readStep.ok();

    // 4. docker login to the registry, password on stdin.
    const registryStep = step("registry-login", `docker login ${expected}`);
    await dockerLogin(registryStep, expected, username.trim(), password);
    registryStep.ok();
  } finally {
    // 5. Best effort: the token's own TTL bounds it if revocation fails.
    await fetch(`${bao}/v1/auth/token/revoke-self`, {
      method: "POST",
      headers: { "X-Vault-Token": baoToken },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => {});
  }
}

main().catch((err) => {
  // A StepError names its step; anything else is a defect in this script.
  console.error(`estate-registry-credential: ${err instanceof StepError ? err.message : `unexpected error: ${err?.message ?? err}`}`);
  process.exit(1);
});
