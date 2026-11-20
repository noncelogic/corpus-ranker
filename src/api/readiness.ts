// GET /readyz: the service is ready only while both of its dependencies
// answer -- the database (a `select 1` over its own login) and the object
// store (a signed HeadBucket with its own credentials). The blue/green
// Rollout's readiness probe calls it (deploy/api.yaml), so a new revision is
// promoted only once it can reach both.
//
// Each check is bounded by `timeoutMs`: a dependency that hangs reports
// "timeout" and one that refuses reports "failed", both as 503. Liveness
// (GET /healthz) stays independent of this, so an outage of a dependency
// takes the pod out of service without restarting it.
import type { Queryable } from "../db/client.ts";
import type { ObjectStore } from "../storage/object-store.ts";
import type { ApiResponse } from "./capture.ts";

export type CheckStatus = "ok" | "failed" | "timeout";

export interface ReadinessDeps {
  db: Queryable;
  store: Pick<ObjectStore, "ping">;
  /** Upper bound on each dependency check, in milliseconds. */
  timeoutMs: number;
  /** Where a failing check's reason goes (default: console.error); never to the HTTP caller. */
  log?: (line: string) => void;
}

/** Default bound on each check: inside the probe's own timeoutSeconds (deploy/api.yaml). */
export const DEFAULT_READINESS_TIMEOUT_MS = 2_000;

class Timeout extends Error {}

async function bounded(name: string, timeoutMs: number, log: (line: string) => void, run: (signal: AbortSignal) => Promise<unknown>): Promise<CheckStatus> {
  const abort = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Timeout());
    }, timeoutMs);
  });
  try {
    // The race bounds checks that cannot be aborted (a query waiting on a connection).
    await Promise.race([run(abort.signal), expired]);
    return "ok";
  } catch (err) {
    if (err instanceof Timeout) {
      log(`readiness: ${name} did not answer within ${timeoutMs}ms`);
      return "timeout";
    }
    log(`readiness: ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  } finally {
    clearTimeout(timer);
  }
}

export async function readiness(deps: ReadinessDeps): Promise<ApiResponse> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const [database, objectStore] = await Promise.all([
    bounded("database", deps.timeoutMs, log, () => deps.db.query("select 1")),
    bounded("object store", deps.timeoutMs, log, (signal) => deps.store.ping(signal)),
  ]);
  const ready = database === "ok" && objectStore === "ok";
  return { status: ready ? 200 : 503, body: { status: ready ? "ready" : "not_ready", checks: { database, object_store: objectStore } } };
}
