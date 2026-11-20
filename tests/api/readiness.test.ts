// CR-D1-PROMOTE acceptance: the readiness endpoint (GET /readyz, the probe the
// blue/green Rollout's promotion waits on, deploy/api.yaml) reports not ready
// until both the database and the object store answer. Each dependency check
// is bounded: an unavailable dependency (its connection reset on arrival), a failed one
// (refused credentials) and a timed-out one (accepts the connection, never
// answers) each answer 503 within the bound. Liveness (GET /healthz) stays
// independent of both, so a dependency outage never restarts the pod.
//
// Runs against the real path: the compose replica's Postgres and MinIO, the
// service's own login, and the default wiring from loadConfig. The time bound
// itself is proved with controlled timers in the "bound:" tests at the end of
// this file, not with a wall clock; these tests assert on the completed response.
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from "node:net";
import type { Server } from "node:http";
import { createServer, loadConfig } from "../../src/server.ts";
import { readiness } from "../../src/api/readiness.ts";
import { freshDatabase, type FreshDb } from "../schema/fresh-db.ts";

const SERVICE = { user: "ranker_rdy", password: "rdy-local-only" };
/** The readiness bound these tests run with; requests below allow it generous patience, not a timing assertion. */
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

/**
 * A dependency that is down: a listener held open for the whole run (so no
 * other server, test or otherwise, can take its port) that resets every
 * connection the moment it arrives, before a byte is exchanged.
 */
async function refusingListener(): Promise<string> {
  const server: TcpServer = createTcpServer((s) => s.resetAndDestroy());
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  cleanups.push(() => new Promise((ok) => server.close(ok)));
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
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
}

async function readyz(base: string): Promise<Readiness> {
  const res = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(TIMEOUT_MS * 4) });
  const body = (await res.json()) as Readiness["body"];
  return { status: res.status, body };
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
    ["unavailable", async () => `postgres://${SERVICE.user}:${SERVICE.password}@${await refusingListener()}/ranker`, "failed"],
    ["failed (login refused)", async () => `postgres://${SERVICE.user}:wrong-password@${pgHost()}/ranker`, "failed"],
    ["timed out", async () => `postgres://${SERVICE.user}:${SERVICE.password}@${await silentListener()}/ranker`, "timeout"],
  ];
  for (const [name, url, expected] of cases) {
    await t.test(name, async () => {
      const base = await start({ databaseUrl: await url() });
      const r = await readyz(base);
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.deepEqual(r.body, { status: "not_ready", checks: { database: expected, object_store: "ok" } });
      await assertLive(base);
    });
  }
});

test("not ready while the object store is unavailable, refuses the credentials or times out, though the database answers", async (t) => {
  const cases: Array<[string, () => Promise<Wiring>, string]> = [
    ["unavailable", async () => ({ s3Endpoint: `http://${await refusingListener()}` }), "failed"],
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
      await assertLive(base);
    });
  }
});

test("not ready while neither answers", async () => {
  const base = await start({
    databaseUrl: `postgres://${SERVICE.user}:${SERVICE.password}@${await silentListener()}/ranker`,
    s3Endpoint: `http://${await refusingListener()}`,
  });
  const r = await readyz(base);
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { status: "not_ready", checks: { database: "timeout", object_store: "failed" } });
  await assertLive(base);
});

// The bound, proved with controlled timers and deferred dependencies rather
// than a wall clock: nothing settles before TIMEOUT_MS of (mocked) time has
// passed, everything has settled once it has, and the two checks run side by
// side so the whole probe answers within one bound, not two.

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((ok) => (resolve = ok));
  return { promise, resolve };
}

/** Call readiness over the given dependency stubs, tracking whether it has answered. */
function probe(db: () => Promise<unknown>, ping: (signal?: AbortSignal) => Promise<unknown>) {
  let settled = false;
  const result = readiness({
    db: { query: db as never },
    store: { ping: ping as never },
    timeoutMs: TIMEOUT_MS,
    log: () => {},
  }).finally(() => (settled = true));
  return { result, settled: () => settled };
}

/** Let pending promise callbacks run (no timers involved). */
const flush = () => new Promise<void>((ok) => setImmediate(ok));

test("bound: a hanging database check answers timeout exactly at the bound, not before", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const hang = deferred<unknown[]>();
  const p = probe(() => hang.promise, async () => {});
  t.mock.timers.tick(TIMEOUT_MS - 1);
  await flush();
  assert.equal(p.settled(), false, "readiness answered before the bound");
  t.mock.timers.tick(1);
  await flush();
  assert.equal(p.settled(), true, "readiness had not answered once the bound passed");
  const r = await p.result;
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { status: "not_ready", checks: { database: "timeout", object_store: "ok" } });
});

test("bound: a hanging object-store check answers timeout at the bound and is aborted", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let seen: AbortSignal | undefined;
  const hang = deferred<void>();
  const p = probe(
    async () => [],
    (signal) => {
      seen = signal;
      return hang.promise;
    },
  );
  t.mock.timers.tick(TIMEOUT_MS - 1);
  await flush();
  assert.equal(p.settled(), false, "readiness answered before the bound");
  assert.equal(seen?.aborted, false);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(p.settled(), true, "readiness had not answered once the bound passed");
  const r = await p.result;
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { status: "not_ready", checks: { database: "ok", object_store: "timeout" } });
  assert.equal(seen?.aborted, true, "the timed-out request must be aborted, not left running");
});

test("bound: both checks hanging answer within one bound, since they run concurrently", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const p = probe(() => deferred<unknown[]>().promise, () => deferred<void>().promise);
  t.mock.timers.tick(TIMEOUT_MS);
  await flush();
  assert.equal(p.settled(), true, "the checks must share one bound, not run one after the other");
  const r = await p.result;
  assert.deepEqual(r.body, { status: "not_ready", checks: { database: "timeout", object_store: "timeout" } });
});

test("bound: a dependency that answers just inside the bound is ok", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const slowDb = deferred<unknown[]>();
  const slowStore = deferred<void>();
  const p = probe(() => slowDb.promise, () => slowStore.promise);
  t.mock.timers.tick(TIMEOUT_MS - 1);
  slowDb.resolve([]);
  slowStore.resolve();
  const r = await p.result;
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { status: "ready", checks: { database: "ok", object_store: "ok" } });
});

test("bound: a dependency that fails answers failed at once, without waiting for the bound", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const p = probe(async () => {
    throw new Error("ECONNREFUSED");
  }, async () => {});
  const r = await p.result; // no tick: the mocked clock never reaches the bound
  assert.deepEqual(r.body, { status: "not_ready", checks: { database: "failed", object_store: "ok" } });
});
