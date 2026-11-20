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
import { spawn } from "node:child_process";

const ROLE = "corpus-ranker-registry-push";
const AUDIENCE = "openbao";
const SECRET_PATH = "kv/data/corpus-ranker/acr-push";
const TIMEOUT_MS = 30_000;

function need(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** fetch + JSON, with a bounded wait and an error that never carries a body. */
async function getJson(what, url, init) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`${what}: request failed (${err?.cause?.code ?? err?.name ?? "error"})`);
  }
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new Error(`${what}: response is not JSON`);
  }
}

function dockerLogin(registry, username, password) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["login", registry, "-u", username, "--password-stdin"], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", (err) => reject(new Error(`docker login: ${err.code ?? err.message}`)));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`docker login exited ${code}`))));
    child.stdin.end(password);
  });
}

async function main() {
  const requestUrl = need("ACTIONS_ID_TOKEN_REQUEST_URL");
  const requestToken = need("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
  const bao = need("OPENBAO_ADDR").replace(/\/+$/, "");
  const expected = need("EXPECTED_REGISTRY");

  const oidcUrl = new URL(requestUrl);
  oidcUrl.searchParams.set("audience", AUDIENCE);
  const oidc = await getJson("GitHub OIDC token", oidcUrl, {
    headers: { Authorization: `Bearer ${requestToken}` },
  });
  if (typeof oidc?.value !== "string" || oidc.value === "") throw new Error("GitHub OIDC token: no value");

  const login = await getJson(`OpenBao auth/jwt/login role ${ROLE}`, `${bao}/v1/auth/jwt/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ role: ROLE, jwt: oidc.value }),
  });
  const baoToken = login?.auth?.client_token;
  if (typeof baoToken !== "string" || baoToken === "") throw new Error("OpenBao login: no client token");

  try {
    const secret = await getJson(`OpenBao read ${SECRET_PATH}`, `${bao}/v1/${SECRET_PATH}`, {
      headers: { "X-Vault-Token": baoToken },
    });
    const data = secret?.data?.data ?? {};
    const { registry, username, password } = data;
    for (const [key, value] of Object.entries({ registry, username, password })) {
      if (typeof value !== "string" || value.trim() === "") throw new Error(`${SECRET_PATH}: no ${key}`);
    }
    // The credential must be for the registry IMAGE names, or the push
    // would go nowhere (or somewhere else).
    if (registry.trim() !== expected) {
      throw new Error(`push credential is for '${registry.trim()}', not ${expected}`);
    }
    await dockerLogin(registry.trim(), username.trim(), password);
  } finally {
    // Best effort: the token's own TTL bounds it if revocation fails.
    await fetch(`${bao}/v1/auth/token/revoke-self`, {
      method: "POST",
      headers: { "X-Vault-Token": baoToken },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(`estate-registry-credential: ${err.message}`);
  process.exit(1);
});
