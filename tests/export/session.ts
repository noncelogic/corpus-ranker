// The export/restore PgSession for a fixture database, as the CLI builds it:
// SQL through the in-process client, the dump through pg_dump (run inside the
// Postgres container). psql is taken off PATH first, so a code path that still
// spawns it fails here as it would on a host without one.
import type { TestContext } from "node:test";
import { pgClient, type Db } from "../../src/db/client.ts";
import type { PgSession } from "../../src/export/bundle.ts";
import type { FreshDb } from "../schema/fresh-db.ts";
import { removePsqlFromPath } from "../db/no-psql.ts";

const clients = new WeakMap<FreshDb, Db>();

/** One pooled client per fixture database, closed when the test ends. */
export function pgSession(t: TestContext, db: FreshDb): PgSession {
  removePsqlFromPath();
  let client = clients.get(db);
  if (!client) {
    const created = pgClient(db.databaseUrl());
    clients.set(db, created);
    t.after(() => created.end());
    client = created;
  }
  return { db: client, dump: db.pgDump };
}
