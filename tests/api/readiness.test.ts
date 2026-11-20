// CR-D1-PROMOTE acceptance: the readiness endpoint (GET /readyz, the probe the
// blue/green Rollout's promotion waits on, deploy/api.yaml) reports not ready
// until both the database and the object store answer. Each dependency check
// is bounded: an unavailable dependency (connection refused), a failed one
// (refused credentials) and a timed-out one (accepts the connection, never
// answers) each answer 503 within the bound. Liveness (GET /healthz) stays
// independent of both, so a dependency outage never restarts the pod.
//
// Runs against the real path: the compose replica's Postgres and MinIO, the
// service's own login, and the default wiring from loadConfig.
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from "node:net";
import type { Server } from "node:http";
import { createServer, loadConfig } from "../../src/server.ts";
import { freshDatabase, type FreshDb } from "../schema/fresh-db.ts";

const SERVICE = { user: "ranker_rdy", password: "rdy-local-only" };
/** The readiness bound these tests run with; a timed-out check must answer well inside the test's patience. */
const TIMEOUT_MS = 1_500;

let db: FreshDb;
const cleanups: (() => unknown)[] = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

before(
  async () => {
    db = await freshDatabase({ after: (fn: () => unknown) => void cleanups.push(fn) } as unknown as TestContext, { minio: true });
    db.psql(`CREATE ROLE ${SERVICE.user} LOGIN PASSWORD '${SERVICE.password}' IN ROLE ranker_app`);
  },
  { timeout: 600_000 },
);

/** A TCP listener that accepts connections and never says a word: a dependency that hangs. */
async function silentListener(): Promise<string> {
  const sockets = new Set<Socket>();
  const server: TcpServer = createTcpServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  cleanups.push(() => {
    for (const s of sockets) s.destroy();
    return new Promise((ok) => server.close(ok));
  });
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A local port nothing listens on: a dependency that is down. */
async function closedPort(): Promise<string> {
  const server = createTcpServer();
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  await new Promise((ok) => server.close(ok));
  return `127.0.0.1:${port}`;
}

const pgHost = (): string => new URL(db.databaseUrl(SERVICE)).host;

interface Wiring {
  databaseUrl?: string;
  s3Endpoint?: string;
  s3SecretAccessKey?: string;
}

/** Start the service with the default wiring for the replica, overridden by `w`; returns its base URL. */
async function start(w: Wiring = {}): Promise<string> {
  const env: Record<string, string> = {
    RANKER_DATABASE_URL: w.databaseUrl ?? db.databaseUrl(SERVICE),
    RANKER_S3_ENDPOINT: w.s3Endpoint ?? db.minioEndpoint!,
  };
  if (w.s3SecretAccessKey !== undefined) env.RANKER_S3_SECRET_ACCESS_KEY = w.s3SecretAccessKey;
  const server: Server = createServer(loadConfig(env), { readinessTimeoutMs: TIMEOUT_MS });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  cleanups.push(() => new Promise((ok) => server.close(ok)));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

interface Readiness {
  status: number;
  body: { status: string; checks: { database: string; object_store: string } };
  ms: number;
}

async function readyz(base: string): Promise<Readiness> {
  const t0 = performance.now();
  const res = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(TIMEOUT_MS * 4) });
  const body = (await res.json()) as Readiness["body"];
  return { status: res.status, body, ms: performance.now() - t0 };
}

async function assertLive(base: string): Promise<void> {
  const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  assert.equal(res.status, 200, "liveness must not depend on the database or the object store");
  await res.arrayBuffer();
}

test("ready once both the database and the object store answer", async () => {
  const base = await start();
  const r = await readyz(base);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { status: "ready", checks: { database: "ok", object_store: "ok" } });
});

test("not ready while the database is unavailable, failed or timed out, though the object store answers", async (t) => {
  const cases: Array<[string, () => Promise<string>, string]> = [
    ["unavailable", async () => `postgres://${SERVICE.user}:${SERVICE.password}@${await closedPort()}/ranker`, "failed"],
    ["failed (login refused)", async () => `postgres://${SERVICE.user}:wrong-password@${pgHost()}/ranker`, "failed"],
    ["timed out", async () => `postgres://${SERVICE.user}:${SERVICE.password}@${await silentListener()}/ranker`, "timeout"],
  ];
  for (const [name, url, expected] of cases) {
    await t.test(name, async () => {
      const base = await start({ databaseUrl: await url() });
      const r = await readyz(base);
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.deepEqual(r.body, { status: "not_ready", checks: { database: expected, object_store: "ok" } });
      assert.ok(r.ms < TIMEOUT_MS * 2, `readiness took ${Math.round(r.ms)}ms; the bound is ${TIMEOUT_MS}ms`);
      await assertLive(base);
    });
  }
});

test("not ready while the object store is unavailable, refuses the credentials or times out, though the database answers", async (t) => {
  const cases: Array<[string, () => Promise<Wiring>, string]> = [
    ["unavailable", async () => ({ s3Endpoint: `http://${await closedPort()}` }), "failed"],
    // The check is authenticated: a reachable store that rejects the ranker's credentials is not ready.
    ["failed (credentials refused)", async () => ({ s3SecretAccessKey: "not-the-writer-secret" }), "failed"],
    ["timed out", async () => ({ s3Endpoint: `http://${await silentListener()}` }), "timeout"],
  ];
  for (const [name, wiring, expected] of cases) {
    await t.test(name, async () => {
      const base = await start(await wiring());
      const r = await readyz(base);
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.deepEqual(r.body, { status: "not_ready", checks: { database: "ok", object_store: expected } });
      assert.ok(r.ms < TIMEOUT_MS * 2, `readiness took ${Math.round(r.ms)}ms; the bound is ${TIMEOUT_MS}ms`);
      await assertLive(base);
    });
  }
});

test("not ready while neither answers", async () => {
  const base = await start({
    databaseUrl: `postgres://${SERVICE.user}:${SERVICE.password}@${await silentListener()}/ranker`,
    s3Endpoint: `http://${await closedPort()}`,
  });
  const r = await readyz(base);
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { status: "not_ready", checks: { database: "timeout", object_store: "failed" } });
  assert.ok(r.ms < TIMEOUT_MS * 2, `readiness took ${Math.round(r.ms)}ms; the bound is ${TIMEOUT_MS}ms`);
  await assertLive(base);
});
