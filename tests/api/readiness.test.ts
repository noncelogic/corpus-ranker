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
//
// No real-path case races a real answer against the real readiness timer: a
// case that expects a dependency to answer (ok, or failed on a reset or a
// refusal) runs with a deadline it cannot reach, so only the answer settles
// the check, and a case that expects a timeout hangs that dependency on a
// listener that never answers, so only the deadline settles it. Which of the
// two wins when both are in play is proved with an injected rejection and a
// mocked clock at the end of this file.
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
/** A deadline no real-path answer can lose to (cleared as soon as the check settles). */
const NO_DEADLINE_MS = 24 * 60 * 60 * 1_000;

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

/**
 * Start the service with the default wiring for the replica, overridden by `w`; returns its base URL.
 * `readinessTimeoutMs` defaults to a deadline the checks cannot reach; pass TIMEOUT_MS only where a
 * dependency hangs, so the deadline is the one thing that can settle it.
 */
async function start(w: Wiring = {}, readinessTimeoutMs = NO_DEADLINE_MS): Promise<string> {
  const env: Record<string, string> = {
    RANKER_DATABASE_URL: w.databaseUrl ?? db.databaseUrl(SERVICE),
    RANKER_S3_ENDPOINT: w.s3Endpoint ?? db.minioEndpoint!,
  };
  if (w.s3SecretAccessKey !== undefined) env.RANKER_S3_SECRET_ACCESS_KEY = w.s3SecretAccessKey;
  const server: Server = createServer(loadConfig(env), { readinessTimeoutMs });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  cleanups.push(() => new Promise((ok) => server.close(ok)));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

interface Readiness {
  status: number;
  body: { status: string; checks: { database: string; object_store: string } };
}

async function readyz(base: string): Promise<Readiness> {
  // Patience for a stuck request only; the readiness result never depends on it.
  const res = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(60_000) });
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
      const base = await start({ databaseUrl: await url() }, expected === "timeout" ? TIMEOUT_MS : NO_DEADLINE_MS);
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
      const base = await start(await wiring(), expected === "timeout" ? TIMEOUT_MS : NO_DEADLINE_MS);
      const r = await readyz(base);
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.deepEqual(r.body, { status: "not_ready", checks: { database: "ok", object_store: expected } });
      await assertLive(base);
    });
  }
});

test("not ready while neither answers", async () => {
  // Both refuse, under a deadline they cannot reach: each check settles on its own reset alone.
  // (One failing while the other times out is proved with controlled timers below.)
  const base = await start({
    databaseUrl: `postgres://${SERVICE.user}:${SERVICE.password}@${await refusingListener()}/ranker`,
    s3Endpoint: `http://${await refusingListener()}`,
  });
  const r = await readyz(base);
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { status: "not_ready", checks: { database: "failed", object_store: "failed" } });
  await assertLive(base);
});

// The bound, proved with controlled timers and deferred dependencies rather
// than a wall clock: nothing settles before TIMEOUT_MS of (mocked) time has
// passed, everything has settled once it has, and the two checks run side by
// side so the whole probe answers within one bound, not two.

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (err: Error) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
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

// failed versus timeout, decided by an explicit step rather than a race: the
// probe's rejection is injected and the readiness clock is mocked, so each
// case settles exactly the way the test drives it, with no real sleep.

test("reports failed when the probe rejects before the readiness deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dbProbe = deferred<unknown[]>();
  const storeProbe = deferred<void>();
  const p = probe(() => dbProbe.promise, () => storeProbe.promise);
  t.mock.timers.tick(TIMEOUT_MS - 1);
  await flush();
  assert.equal(p.settled(), false, "readiness answered before either probe settled or the deadline passed");
  dbProbe.reject(new Error("ECONNRESET"));
  storeProbe.reject(new Error("ECONNRESET"));
  await flush();
  assert.equal(p.settled(), true, "readiness had not answered once both probes rejected");
  t.mock.timers.tick(1); // the deadline now passes; it must not overturn the answer already given
  const r = await p.result;
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { status: "not_ready", checks: { database: "failed", object_store: "failed" } });
});

test("reports timeout when the readiness deadline passes before the probe settles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dbProbe = deferred<unknown[]>();
  const storeProbe = deferred<void>();
  const p = probe(() => dbProbe.promise, () => storeProbe.promise);
  t.mock.timers.tick(TIMEOUT_MS);
  await flush();
  assert.equal(p.settled(), true, "readiness had not answered once the deadline passed");
  // The probes reject only after the deadline; the timeout already reported stands.
  dbProbe.reject(new Error("ECONNRESET"));
  storeProbe.reject(new Error("ECONNRESET"));
  await flush();
  const r = await p.result;
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { status: "not_ready", checks: { database: "timeout", object_store: "timeout" } });
});
