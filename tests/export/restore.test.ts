// CR-M2-T4b acceptance: a restore that fails leaves its target exactly as it
// was found (empty) so the same restore can run again, and a target that
// already holds corpus data is refused, naming the target, before any write.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportBundle, restoreBundle, type PgSession } from "../../src/export/bundle.ts";
import { freshDatabase, type FreshDb } from "../schema/fresh-db.ts";

const session = (db: FreshDb): PgSession => ({ query: db.psql, dump: db.pgDump, open: db.psqlProcess });

const SEED = `
insert into corpora (id, name, description, taxonomy_id, status, created_at)
  values ('cr_corpus_papers01', 'papers', 'AI papers', 'cr_tax_papers01', 'active', '2026-11-01T00:00:00Z');
insert into items (id, corpus_id, item_type, title, summary, canonical_fields, identity_keys, status, created_at, updated_at)
  values ('cr_item_p1', 'cr_corpus_papers01', 'paper', 'Paper One', null, '{}', '{"arxiv_id":"2611.01234"}',
          'active', '2026-11-03T08:00:00Z', '2026-11-03T08:00:00Z'),
         ('cr_item_p2', 'cr_corpus_papers01', 'paper', 'Paper Two', null, '{}', '{"arxiv_id":"2611.02345"}',
          'active', '2026-11-06T00:00:00Z', '2026-11-06T00:00:00Z');
`;

// Everything a restore could write: user relations, schemas, types,
// functions, extensions and roles.
const STATE = `
select json_build_object(
  'relations', (select coalesce(json_agg(n.nspname || '.' || c.relname order by n.nspname, c.relname), '[]')
                  from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'),
  'schemas', (select json_agg(nspname order by nspname) from pg_namespace),
  'types', (select count(*) from pg_type),
  'functions', (select count(*) from pg_proc),
  'extensions', (select json_agg(extname order by extname) from pg_extension),
  'roles', (select json_agg(rolname order by rolname) from pg_roles))`;

const rewrite = (dir: string, file: string, edit: (s: string) => string, manifestEdit?: (m: any) => void) => {
  const body = edit(readFileSync(join(dir, file), "utf8"));
  writeFileSync(join(dir, file), body);
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  manifest.files[file] = { sha256: createHash("sha256").update(body).digest("hex"), bytes: Buffer.byteLength(body) };
  manifestEdit?.(manifest);
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
};

test("a restore that fails verification leaves the target empty, and the same restore retried against it succeeds", { timeout: 900_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "cr-restore-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const [source, target] = await Promise.all([freshDatabase(t), freshDatabase(t, { migrate: false })]);
  source.psql(SEED);
  const good = join(tmp, "good");
  const manifest = await exportBundle(session(source), good);

  const found = target.psql(STATE);
  const bundleDir = join(tmp, "bundle");
  const faults: [string, (dir: string) => void, RegExp][] = [
    // The dump loads but does not reproduce the bundle's JSONL.
    ["inconsistent snapshot", (d) => rewrite(d, "database.sql", (s) => s.replace("Paper Two", "Paper 2")),
      /items\.jsonl: restored database does not reproduce the bundle/],
    // The dump loads and matches, but is not at the schema version the manifest records.
    ["schema-version mismatch", (d) => rewrite(d, "database.sql", (s) => s, (m) => { m.schema_version += 1; }),
      /schema version/],
    // The dump breaks off part-way through loading.
    ["dump that fails to load", (d) => rewrite(d, "database.sql", (s) => s.replace(/COPY public\.items /, "COPY public.no_such_table ")),
      /psql exited/],
  ];
  for (const [fault, inject, expected] of faults) {
    rmSync(bundleDir, { recursive: true, force: true });
    cpSync(good, bundleDir, { recursive: true });
    inject(bundleDir);
    await assert.rejects(restoreBundle(session(target), bundleDir), expected, fault);
    assert.equal(target.psql(STATE), found, `${fault}: target left as found`);
  }

  // The same restore, against the same target, succeeds once the bundle is sound.
  rmSync(bundleDir, { recursive: true, force: true });
  cpSync(good, bundleDir, { recursive: true });
  assert.deepEqual(await restoreBundle(session(target), bundleDir), manifest);
  const items = "select string_agg(id || ':' || title, ',' order by id) from items";
  assert.equal(target.psql(items), source.psql(items));
});

test("restore into a target that already holds corpus data is refused before any write", { timeout: 900_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "cr-restore-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const [source, target] = await Promise.all([freshDatabase(t), freshDatabase(t, { migrate: false })]);
  source.psql(SEED);
  const bundleDir = join(tmp, "bundle");
  await exportBundle(session(source), bundleDir);

  // Corpus data the restore must not touch, in a target with no ranker role yet.
  target.psql("create table corpora (id text primary key, name text); insert into corpora values ('cr_corpus_mine', 'mine');");
  const found = target.psql(STATE);
  const rows = target.psql("select json_agg(c order by id) from corpora c");

  await assert.rejects(restoreBundle(session(target), bundleDir), /restore target database "ranker" is not empty/);
  assert.equal(target.psql(STATE), found);
  assert.equal(target.psql("select json_agg(c order by id) from corpora c"), rows);
  assert.equal(target.psql("select count(*) from pg_roles where rolname = 'ranker_app'"), "0");

  // A migrated target holding the corpus itself is refused the same way.
  const sourceFound = source.psql(STATE);
  await assert.rejects(restoreBundle(session(source), bundleDir), /restore target database "ranker" is not empty/);
  assert.equal(source.psql(STATE), sourceFound);
  assert.equal(source.psql("select count(*) from items"), "2");
});
