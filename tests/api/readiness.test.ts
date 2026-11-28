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
// the check. A case that expects a timeout hangs that dependency on a
// listener that never answers and runs the readiness deadline on a mocked
// clock: the test waits until the listener has received the hanging probe's
// bytes and the healthy peer's real check has completed, checks on the server
// that no response has been started, then advances the clock past the
// deadline, so however slow the runner is, the peer reports ok and only the
// hanging dependency reports timeout. Which of the two wins when both are in
// play is proved with an injected rejection and a mocked clock at the end of
// this file.
import { after, before, test, type TestContext } from "node:test";
import { AsyncLocalStorage, createHook } from "node:async_hooks";
import assert from "node:assert/strict";
import { connect, createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from "node:net";
import type { Server, ServerResponse } from "node:http";
import { createServer, loadConfig } from "../../src/server.ts";
import { readiness } from "../../src/api/readiness.ts";
import { pgClient, type Db } from "../../src/db/client.ts";
import { s3ObjectStore, type ObjectStore } from "../../src/storage/object-store.ts";
import { freshDatabase, type FreshDb } from "../schema/fresh-db.ts";

const SERVICE = { user: "ranker_rdy", password: "rdy-local-only" };
/** The readiness bound these tests run with (on a mocked clock wherever a dependency hangs). */
const TIMEOUT_MS = 1_500;
/**
 * Real-time patience for the harness's own waits (probe bytes arriving, the healthy peer answering):
 * a stuck step fails the test instead of hanging it. No readiness result depends on it.
 */
const HARNESS_WATCHDOG_MS = 60_000;
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

/** A dependency that hangs: where it listens, and a signal for the first probe bytes it receives. */
interface SilentListener {
  host: string;
  /** Resolves on the listener's first `data` event: the first probe bytes (a Postgres startup or an HTTP request) have arrived. */
  arrived: Promise<void>;
}

/** A TCP listener that accepts connections, reads what they send and never says a word: a dependency that hangs. */
async function silentListener(): Promise<SilentListener> {
  const sockets = new Set<Socket>();
  const arrived = deferred<void>();
  const server: TcpServer = createTcpServer((s) => {
    sockets.add(s);
    s.on("data", () => {
      arrived.resolve();
    });
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  cleanups.push(() => {
    for (const s of sockets) s.destroy();
    return new Promise((ok) => server.close(ok));
  });
  return { host: `127.0.0.1:${(server.address() as AddressInfo).port}`, arrived: arrived.promise };
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

/** The service's config: the default wiring for the replica, overridden by `w`. */
function config(w: Wiring = {}) {
  const env: Record<string, string> = {
    RANKER_DATABASE_URL: w.databaseUrl ?? db.databaseUrl(SERVICE),
    RANKER_S3_ENDPOINT: w.s3Endpoint ?? db.minioEndpoint!,
  };
  if (w.s3SecretAccessKey !== undefined) env.RANKER_S3_SECRET_ACCESS_KEY = w.s3SecretAccessKey;
  return loadConfig(env);
}

/** Listen on port 0 and return the base URL; the server is closed after the run. */
async function listen(server: Server): Promise<string> {
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  cleanups.push(() => new Promise((ok) => server.close(ok)));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * Start the service with the default wiring for the replica, overridden by `w`, under a readiness
 * deadline the checks cannot reach, so only each dependency's own answer settles its check; returns
 * its base URL. A hanging dependency goes through readyzAtTheDeadline instead.
 */
async function start(w: Wiring = {}): Promise<string> {
  return listen(createServer(config(w), { readinessTimeoutMs: NO_DEADLINE_MS }));
}

interface Readiness {
  status: number;
  body: { status: string; checks: { database: string; object_store: string } };
}

async function readyz(base: string, signal: AbortSignal = AbortSignal.timeout(HARNESS_WATCHDOG_MS)): Promise<Readiness> {
  // Patience for a stuck request only (the mixed cases pass their one harness deadline instead);
  // the readiness result never depends on it.
  const res = await fetch(`${base}/readyz`, { signal });
  const body = (await res.json()) as Readiness["body"];
  return { status: res.status, body };
}

/**
 * GET /readyz from a service whose `hanging` dependency is wired to `silent` while its other one is
 * the healthy replica, deciding the result by explicit steps on a mocked readiness clock rather than
 * a race: the hanging check's probe bytes are seen arriving at the silent listener, the healthy
 * peer's real check is seen completed, the server is seen not to have started its response, and
 * only then does the clock pass the deadline. The request, both waits and the response all run under
 * one cancellable harness deadline (underOneDeadline). Returns the completed response and the base URL.
 */
async function readyzAtTheDeadline(t: TestContext, w: Wiring, hanging: "database" | "object_store", silent: SilentListener) {
  const cfg = config(w);
  // Only the real timers this case's own pool starts are counted, never a process-wide total: a real
  // timer elsewhere (an earlier case's idle pool) may start or expire at any moment during the case.
  const poolTimers = ownedRealTimers();
  t.after(() => poolTimers.stop());
  const healthyDone = deferred<void>();
  /** The healthy dependency's real check, reporting when it has completed. */
  const healthy = <R>(run: Promise<R>): Promise<R> =>
    run.then(
      (r) => (healthyDone.resolve(), r),
      (err: Error) => (healthyDone.reject(err), Promise.reject(err)),
    );
  const pool = pgClient(cfg.databaseUrl);
  // Every call into the pool runs as its owner, so the timers it starts (and those of the connections it opens) are tracked.
  const realDb: Db = { ...pool, query: ((text: string, params?: never) => poolTimers.own(() => pool.query(text, params))) as Db["query"] };
  // Ended without waiting, as the server ends the pool it owns: a query still stuck on the silent
  // listener settles when that listener's cleanup drops its sockets.
  cleanups.push(() => void realDb.end());
  const realStore = s3ObjectStore(cfg.objectStore);
  let db: Db;
  let store: ObjectStore;
  if (hanging === "object_store") {
    // The healthy pool connects inside the readiness check itself, on the mocked clock: its zero-delay
    // connect timer is released by releasingDueTimers' tick(0), and its idle timer is a mocked one too.
    db = { ...realDb, query: ((text: string, params?: never) => healthy(realDb.query(text, params))) as Db["query"] };
    store = realStore;
  } else {
    db = realDb;
    store = { ...realStore, ping: (signal) => healthy(realStore.ping(signal)) };
  }
  const server = createServer(cfg, { db, store, readinessTimeoutMs: TIMEOUT_MS });
  /** The server's side of the readiness request: whether it has started (or finished) its response. */
  let served: ServerResponse | undefined;
  server.on("request", (_req, res: ServerResponse) => (served = res));
  const base = await listen(server);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // AbortSignal.timeout runs on Node's internal timers, which the mocked setTimeout does not hold back.
  const r = await underOneDeadline(AbortSignal.timeout(HARNESS_WATCHDOG_MS), (signal) => readyz(base, signal), async (wait) => {
    // Both probes are observed from the start: the hanging one's bytes arriving and the healthy peer's real check.
    await releasingDueTimers(t, () =>
      Promise.all([
        wait(silent.arrived, `the hanging ${hanging} probe never reached its silent listener`),
        wait(healthyDone.promise, `the healthy peer of the hanging ${hanging} never answered`),
      ]),
    );
    assert.ok(served, "the server never received the readiness request");
    assert.equal(served.headersSent, false, "readiness answered before the deadline passed, with one dependency still hanging");
    assert.equal(served.writableEnded, false, "readiness answered before the deadline passed, with one dependency still hanging");
    t.mock.timers.tick(TIMEOUT_MS);
  });
  // Every timer this case's pool started runs on the mocked clock or has been cleared: a real one (e.g.
  // an idle timer armed before the clock was mocked) cannot be cancelled by the mocked clearTimeout and
  // would keep the test process alive for its whole delay after the last assertion.
  assert.deepEqual(await poolTimers.running(), [], `the timed-out ${hanging} case's pool left a real timer running`);
  return { r, base };
}

/**
 * The real timers started by code run through `own` (and by the async work it starts, such as a pool's
 * connections), tracked by handle from creation until cleared or fired. A mocked timer is no real
 * resource, so it is never seen; a real timer started anywhere else is never counted.
 */
function ownedRealTimers() {
  const owner = new AsyncLocalStorage<true>();
  const live = new Set<number>();
  const hook = createHook({
    init: (id, type) => {
      if (type === "Timeout" && owner.getStore()) live.add(id);
    },
    destroy: (id) => {
      live.delete(id);
    },
  }).enable();
  return {
    own: <R>(run: () => R): R => owner.run(true, run),
    /** The handles still running, once the destroy events already due have been delivered. */
    running: async (): Promise<number[]> => {
      await flush();
      return [...live];
    },
    stop: () => void hook.disable(),
  };
}

test("harness: the leaked-timer check counts only the owner's real timers, not one elsewhere expiring meanwhile", async (t) => {
  // A real timer outside the owner (an earlier case's idle pool), running when the case starts and expiring during it.
  const outside = deferred<void>();
  setTimeout(() => outside.resolve(), 0);
  const timers = ownedRealTimers();
  t.after(() => timers.stop());
  await outside.promise;
  assert.deepEqual(await timers.running(), [], "a real timer the owner never started was counted against it");
  // A real timer the owner starts and leaves running is caught; once cleared it is not.
  const leaked = timers.own(() => setTimeout(() => {}, NO_DEADLINE_MS));
  assert.equal((await timers.running()).length, 1, "a real timer the owner left running was missed");
  clearTimeout(leaked);
  assert.deepEqual(await timers.running(), [], "a cleared timer was still counted");
  // A real timer started by async work the owner began (as a pool's connection arms its idle timer) is the owner's too.
  const fromItsWork = deferred<NodeJS.Timeout>();
  timers.own(() => setImmediate(() => fromItsWork.resolve(setTimeout(() => {}, NO_DEADLINE_MS))));
  const late = await fromItsWork.promise;
  assert.equal((await timers.running()).length, 1, "a real timer started by the owner's async work was missed");
  clearTimeout(late);
  // A timer on the mocked clock is no real resource: never counted.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  timers.own(() => setTimeout(() => {}, NO_DEADLINE_MS));
  assert.deepEqual(await timers.running(), [], "a mocked timer was counted as a real one");
});

/** Await `step` until it settles or a step's harness deadline aborts, whichever comes first. */
type Wait = <S>(step: Promise<S>, what: string) => Promise<S>;

/**
 * Run a readiness request and the harness's steps under one cancellable harness deadline (real time,
 * never the mocked readiness clock): the request starts at once under that deadline (its only abort
 * timer), and every `wait` in `steps` ends as soon as the deadline passes or the request settles, since
 * a request that settles before the steps are done never reached the deadline step. If anything
 * fails, the request is cancelled and awaited before the failure is reported. Once the steps are done
 * the request's own answer is returned, still bounded by the same deadline.
 */
async function underOneDeadline<T>(deadline: AbortSignal, request: (signal: AbortSignal) => Promise<T>, steps: (wait: Wait) => Promise<void>): Promise<T> {
  const cancel = new AbortController();
  const pending = request(AbortSignal.any([deadline, cancel.signal]));
  const settledEarly = pending.then(
    () => Promise.reject(new Error("the readiness request settled before the deadline step: it answered")),
    (err: Error) => Promise.reject(new Error("the readiness request settled before the deadline step: it failed", { cause: err })),
  );
  settledEarly.catch(() => {}); // reported only through a wait that it ends
  try {
    await steps(waitUnder(deadline, settledEarly));
  } catch (err) {
    cancel.abort(err);
    await pending.catch(() => {});
    throw err;
  }
  return pending;
}

/** A Wait that ends each step once `deadline` aborts or `alsoEnds` (if given) rejects, whichever comes first. */
function waitUnder(deadline: AbortSignal, alsoEnds: Promise<never> = never): Wait {
  return (step, what) =>
    new Promise((ok, fail) => {
      const onAbort = () => fail(new Error(`${what} within the harness deadline (${HARNESS_WATCHDOG_MS} ms of real time)`));
      if (deadline.aborted) return onAbort();
      deadline.addEventListener("abort", onAbort, { once: true });
      Promise.race([step, alsoEnds])
        .then(ok, fail)
        .finally(() => deadline.removeEventListener("abort", onAbort));
    });
}

/**
 * Run `waiting` while releasing the mocked timers due now. postgres.js schedules its connect with a
 * zero-delay setTimeout, which the mocked clock holds back, so while waiting a real setInterval (not
 * mocked: only setTimeout is) keeps releasing them with tick(0). tick(0) never moves the mocked clock,
 * so the readiness deadline, TIMEOUT_MS ahead, stays frozen. The wait ends on what `waiting` awaits
 * (the probe's data event itself), not after a number of turns.
 */
async function releasingDueTimers<T>(t: TestContext, waiting: () => Promise<T>): Promise<T> {
  const release = setInterval(() => t.mock.timers.tick(0), 1);
  try {
    return await waiting();
  } finally {
    clearInterval(release);
  }
}

async function assertLive(base: string): Promise<void> {
  const res = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  assert.equal(res.status, 200, "liveness must not depend on the database or the object store");
  await res.arrayBuffer();
}

test("harness: a hanging probe's bytes are awaited however many event-loop turns they take to arrive", async (t) => {
  const silent = await silentListener();
  const [host, port] = silent.host.split(":");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let deadlinePassed = false;
  setTimeout(() => (deadlinePassed = true), TIMEOUT_MS); // stands in for the readiness deadline
  // A slow runner: the client only gets as far as scheduling its connect (with a zero-delay timer
  // the mocked clock holds back, as postgres.js does) after more event-loop turns than any fixed
  // turn budget allows, and only then do its bytes travel over real TCP.
  let client: Socket | undefined;
  const late = (async () => {
    for (let turn = 0; turn <= 10_000; turn++) await flush();
    setTimeout(() => {
      client = connect(Number(port), host, () => client!.write("startup"));
    }, 0);
  })();
  try {
    const wait = waitUnder(AbortSignal.timeout(HARNESS_WATCHDOG_MS));
    await releasingDueTimers(t, () => wait(silent.arrived, "the late probe never reached its silent listener"));
    assert.equal(deadlinePassed, false, "waiting for the probe bytes moved the mocked readiness clock");
  } finally {
    await late;
    client?.destroy();
  }
});

/**
 * A stand-in readiness request. Its completion is a gate the test releases (`answer`), kept apart from
 * cancellation: an abort is only recorded (`aborted` resolves on the abort event), so a test can see the
 * request cancelled yet still in flight and check the helper keeps awaiting it until the gate is released.
 */
function fakeRequest() {
  const answer = deferred<string>();
  const aborted = deferred<void>();
  let seen: AbortSignal | undefined;
  let settled = false;
  const request = (signal: AbortSignal): Promise<string> => {
    seen = signal;
    signal.addEventListener("abort", () => aborted.resolve(), { once: true });
    return answer.promise.finally(() => (settled = true));
  };
  return { request, answer, aborted: aborted.promise, signal: () => seen, settled: () => settled };
}

/** Track whether `run` has settled, without leaving its rejection unhandled. */
function tracked(run: Promise<unknown>): () => boolean {
  let done = false;
  run.then(
    () => (done = true),
    () => (done = true),
  );
  return () => done;
}

/**
 * After the request has been cancelled: the helper must still be pending while the cancelled request
 * is in flight, and settle only once the test releases the request's completion gate.
 */
async function assertAwaitsCancelledRequest(req: ReturnType<typeof fakeRequest>, run: Promise<unknown>, failure: RegExp): Promise<void> {
  const runSettled = tracked(run);
  await req.aborted; // the abort event itself, not a guess at how many turns it takes
  assert.equal(req.signal()?.aborted, true, "the request must be cancelled");
  await flush();
  assert.equal(req.settled(), false, "the fake request completes only when the test releases it");
  assert.equal(runSettled(), false, "the case failed while its cancelled request was still in flight: the helper must await it");
  req.answer.reject(new Error("aborted"));
  await assert.rejects(run, failure);
  assert.equal(req.settled(), true, "the request must be awaited before the case fails");
}

const never = new Promise<never>(() => {});

test("harness: a readiness request that fails during the waits ends them at once, not at the harness deadline", { timeout: 10_000 }, async () => {
  const deadline = new AbortController(); // never fires: only the request's failure can end the wait
  const req = fakeRequest();
  const run = underOneDeadline(deadline.signal, req.request, async (wait) => {
    await wait(never, "the hanging probe never reached its silent listener");
  });
  await flush();
  req.answer.reject(new Error("socket hang up"));
  await assert.rejects(run, (err: Error) => {
    assert.match(err.message, /the readiness request settled before the deadline step/);
    assert.match(String((err.cause as Error)?.message), /socket hang up/);
    return true;
  });
});

test("harness: a readiness request answered during the waits ends them at once", { timeout: 10_000 }, async () => {
  const req = fakeRequest();
  const run = underOneDeadline(new AbortController().signal, req.request, async (wait) => {
    await wait(never, "the healthy peer never answered");
  });
  await flush();
  req.answer.resolve("ready");
  await assert.rejects(run, /the readiness request settled before the deadline step/);
});

test("harness: when the one harness deadline passes, the request is cancelled and awaited before the case fails", { timeout: 10_000 }, async () => {
  const deadline = new AbortController();
  const req = fakeRequest();
  const run = underOneDeadline(deadline.signal, req.request, async (wait) => {
    await wait(never, "the hanging probe never reached its silent listener");
  });
  await flush();
  assert.equal(req.signal()?.aborted, false, "the request must run under the harness deadline from the start");
  deadline.abort();
  await assertAwaitsCancelledRequest(req, run, /the hanging probe never reached its silent listener within the harness deadline/);
});

test("harness: a failing step cancels and awaits the request", { timeout: 10_000 }, async () => {
  const req = fakeRequest();
  const run = underOneDeadline(new AbortController().signal, req.request, async () => {
    assert.fail("readiness answered before the deadline passed");
  });
  await assertAwaitsCancelledRequest(req, run, /readiness answered before the deadline passed/);
});

test("harness: once the steps are done the request's own answer is returned, still under the harness deadline", { timeout: 10_000 }, async () => {
  const deadline = new AbortController();
  const req = fakeRequest();
  const steps = deferred<void>();
  const run = underOneDeadline(deadline.signal, req.request, (wait) => wait(steps.promise, "a step"));
  steps.resolve();
  await flush();
  req.answer.resolve("ready");
  assert.equal(await run, "ready");
  assert.equal(req.signal()?.aborted, false);
});

test("ready once both the database and the object store answer", async () => {
  const base = await start();
  const r = await readyz(base);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body, { status: "ready", checks: { database: "ok", object_store: "ok" } });
});

test("not ready while the database is unavailable, failed or timed out, though the object store answers", async (t) => {
  const cases: Array<[string, () => Promise<string>]> = [
    ["unavailable", async () => `postgres://${SERVICE.user}:${SERVICE.password}@${await refusingListener()}/ranker`],
    ["failed (login refused)", async () => `postgres://${SERVICE.user}:wrong-password@${pgHost()}/ranker`],
  ];
  for (const [name, url] of cases) {
    await t.test(name, async () => {
      const base = await start({ databaseUrl: await url() });
      const r = await readyz(base);
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.deepEqual(r.body, { status: "not_ready", checks: { database: "failed", object_store: "ok" } });
      await assertLive(base);
    });
  }
  await t.test("timed out", async (t) => {
    const silent = await silentListener();
    const databaseUrl = `postgres://${SERVICE.user}:${SERVICE.password}@${silent.host}/ranker`;
    const { r, base } = await readyzAtTheDeadline(t, { databaseUrl }, "database", silent);
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.deepEqual(r.body, { status: "not_ready", checks: { database: "timeout", object_store: "ok" } });
    await assertLive(base);
  });
});

test("not ready while the object store is unavailable, refuses the credentials or times out, though the database answers", async (t) => {
  const cases: Array<[string, () => Promise<Wiring>]> = [
    ["unavailable", async () => ({ s3Endpoint: `http://${await refusingListener()}` })],
    // The check is authenticated: a reachable store that rejects the ranker's credentials is not ready.
    ["failed (credentials refused)", async () => ({ s3SecretAccessKey: "not-the-writer-secret" })],
  ];
  for (const [name, wiring] of cases) {
    await t.test(name, async () => {
      const base = await start(await wiring());
      const r = await readyz(base);
      assert.equal(r.status, 503, JSON.stringify(r.body));
      assert.deepEqual(r.body, { status: "not_ready", checks: { database: "ok", object_store: "failed" } });
      await assertLive(base);
    });
  }
  await t.test("timed out", async (t) => {
    const silent = await silentListener();
    const { r, base } = await readyzAtTheDeadline(t, { s3Endpoint: `http://${silent.host}` }, "object_store", silent);
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.deepEqual(r.body, { status: "not_ready", checks: { database: "ok", object_store: "timeout" } });
    await assertLive(base);
  });
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

test("reports failed and timeout in one response when one probe rejects before the deadline and the other is still pending", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dbProbe = deferred<unknown[]>();
  const storeProbe = deferred<void>();
  const p = probe(() => dbProbe.promise, () => storeProbe.promise);
  dbProbe.reject(new Error("ECONNRESET")); // the database rejects first, on the mocked clock's time 0
  await flush();
  assert.equal(p.settled(), false, "readiness answered while the object-store probe was still pending before the deadline");
  t.mock.timers.tick(TIMEOUT_MS); // only now does the deadline pass, with the object-store probe still pending
  await flush();
  assert.equal(p.settled(), true, "readiness had not answered once the deadline passed");
  const r = await p.result;
  assert.equal(r.status, 503);
  assert.deepEqual(r.body, { status: "not_ready", checks: { database: "failed", object_store: "timeout" } });
});
