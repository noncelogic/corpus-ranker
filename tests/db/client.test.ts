// CR-M3-PGCLIENT acceptance: the service reaches Postgres through the packaged
// in-process client (src/db/client.ts), with parameterised queries, and needs
// no psql binary. psql is removed from PATH before the client is used, so the
// test host cannot supply what the service image lacks. The database is the
// compose replica, driven from the host only over the Postgres wire protocol;
// the fixture's own setup SQL runs inside the container.
import { before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { pgClient, type Db } from "../../src/db/client.ts";
import { freshDatabase, type FreshDb } from "../schema/fresh-db.ts";
import { removePsqlFromPath } from "./no-psql.ts";

const SERVICE = { user: "ranker_svc", password: "svc-local-only" };
const CORPUS = "cr_corpus_papers01";

let fresh: FreshDb;
let db: Db;
const cleanups: (() => unknown)[] = [];

before(
  async () => {
    fresh = await freshDatabase({ after: (fn: () => unknown) => void cleanups.push(fn) } as unknown as TestContext);
    // The service's login, granted the app role as deployment does (CR-D1).
    fresh.psql(`CREATE ROLE ${SERVICE.user} LOGIN PASSWORD '${SERVICE.password}' IN ROLE ranker_app;
      insert into corpora (id, name, description, taxonomy_id, status)
        values ('${CORPUS}', 'papers', 'AI papers', 'cr_tax_papers1', 'active');`);
    removePsqlFromPath();
    db = pgClient(fresh.databaseUrl(SERVICE));
  },
  { timeout: 600_000 },
);

test.after(async () => {
  await db?.end();
  for (const fn of cleanups.reverse()) await fn();
});

test("runs a parameterised query and a rolled-back transaction against the Postgres container with no psql binary on PATH", async () => {
  // Parameters travel separately from the SQL text: a value that would break
  // out of a string literal is just data.
  const hostile = "x'); drop table corpora; --";
  const rows = await db.query<{ id: string; echoed: string; n: number }>(
    "select id, $2::text as echoed, $3::int as n from corpora where id = $1",
    [CORPUS, hostile, 7],
  );
  assert.deepEqual(rows, [{ id: CORPUS, echoed: hostile, n: 7 }]);
  assert.deepEqual(await db.query("select id from corpora where id = $1", [hostile]), []);

  // A transaction that fails part-way leaves nothing behind.
  const boom = new Error("abort after insert");
  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.query(
        `insert into originals (id, corpus_id, content_hash, media_type, byte_size, storage_uri, source, raw_metadata)
         values ($1, $2, $3, 'text/plain', 1, $4, $5::jsonb, '{}'::jsonb)`,
        ["cr_orig_rollback1", CORPUS, "a".repeat(64), `s3://ranker-originals/${"a".repeat(64)}`, JSON.stringify({ k: 1 })],
      );
      // Visible inside the transaction...
      assert.deepEqual(await tx.query("select count(*)::int as n from originals"), [{ n: 1 }]);
      throw boom;
    }),
    (err) => err === boom,
  );
  // ...and gone after the rollback.
  assert.deepEqual(await db.query("select count(*)::int as n from originals"), [{ n: 0 }]);

  // A committed transaction returns the callback's value and persists.
  const id = await db.transaction(async (tx) => {
    const [row] = await tx.query<{ id: string }>(
      `insert into originals (id, corpus_id, content_hash, media_type, byte_size, storage_uri, source, raw_metadata)
       values ($1, $2, $3, 'text/plain', 1, $4, $5::jsonb, '{}'::jsonb) returning id`,
      ["cr_orig_commit01", CORPUS, "b".repeat(64), `s3://ranker-originals/${"b".repeat(64)}`, JSON.stringify({ q: "it's" })],
    );
    return row!.id;
  });
  assert.equal(id, "cr_orig_commit01");
  assert.equal(fresh.psql("select count(*) from originals"), "1");
  // JSON text bound to a jsonb parameter is stored as that object, and a json
  // result column comes back parsed.
  assert.deepEqual(await db.query("select source, json_build_object('n', 1) as j from originals where id = $1", [id]), [
    { source: { q: "it's" }, j: { n: 1 } },
  ]);
});

test("the service login keeps the app role's append-only grants through the client", async () => {
  await db.query(
    `insert into policies (id, version, name, corpus_id, dimensions, judge_config, composite_rule, created_by)
     values ('cr_pol_rubric', 1, 'paper-rubric', $1, '[{"name":"Relevance"}]',
             '{"allowed_scorers":[],"source_blind":false}', '{"method":"weighted_sum","tie_breaks":[]}', 'joe')`,
    [CORPUS],
  );
  const denied = /permission denied/;
  await assert.rejects(db.query("update policies set name = $1", ["x"]), denied);
  await assert.rejects(db.query("delete from originals"), denied);
  await assert.rejects(db.query("create table rogue (id int)"), denied);
});

test("a statement error is reported with Postgres's message", async () => {
  await assert.rejects(db.query("select * from no_such_table"), /relation "no_such_table" does not exist/);
});
