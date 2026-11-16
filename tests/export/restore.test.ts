// CR-M2-T4b acceptance: a restore that fails leaves its target exactly as it
// was found (empty) so the same restore can run again, and a target that
// already holds corpus data is refused, naming the target, before any write.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLE_VERSION, exportBundle, restoreBundle, verifyBundle } from "../../src/export/bundle.ts";
import { freshDatabase } from "../schema/fresh-db.ts";
import { pgSession as session } from "./session.ts";


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
  const manifest = await exportBundle(session(t, source), good);

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
    ["dump that fails to load", (d) => rewrite(d, "database.sql", (s) => s.replace(/INSERT INTO public\.items /, "INSERT INTO public.no_such_table ")),
      /relation "public\.no_such_table" does not exist/],
    // A COPY ... FROM stdin block (bundles exported before --inserts) whose
    // rows the server rejects part-way through the load.
    ["COPY rows that fail to load", (d) => rewrite(d, "database.sql", (s) => `${s}\nCOPY public.corpora (id, name, description, taxonomy_id, status, created_at) FROM stdin;\n`
      + `cr_corpus_x\tx\tX\tcr_tax_x\tactive\t2026-11-01 00:00:00+00\ncr_corpus_papers01\tdup\tD\tcr_tax_x\tactive\t2026-11-01 00:00:00+00\n\\.\n`),
      /duplicate key value violates unique constraint/],
    // A COPY row with the wrong number of fields is refused before any write.
    ["COPY row of the wrong width", (d) => rewrite(d, "database.sql", (s) => `${s}\nCOPY public.corpora (id, name) FROM stdin;\ncr_corpus_x\tx\textra\n\\.\n`),
      /row 1 has 3 fields, expected 2/],
    // A COPY ... FROM stdin block with no terminating \. line is refused before any write.
    ["unterminated COPY block", (d) => rewrite(d, "database.sql", (s) => `${s}\nCOPY public.corpora (id, name) FROM stdin;\ncr_corpus_x\tx\n`),
      /has no terminating \\\. line/],
  ];
  for (const [fault, inject, expected] of faults) {
    rmSync(bundleDir, { recursive: true, force: true });
    cpSync(good, bundleDir, { recursive: true });
    inject(bundleDir);
    await assert.rejects(restoreBundle(session(t, target), bundleDir), expected, fault);
    assert.equal(target.psql(STATE), found, `${fault}: target left as found`);
  }

  // The same restore, against the same target, succeeds once the bundle is sound.
  rmSync(bundleDir, { recursive: true, force: true });
  cpSync(good, bundleDir, { recursive: true });
  assert.deepEqual(await restoreBundle(session(t, target), bundleDir), manifest);
  const items = "select string_agg(id || ':' || title, ',' order by id) from items";
  assert.equal(target.psql(items), source.psql(items));
});

test("restore into a target that already holds corpus data is refused before any write", { timeout: 900_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "cr-restore-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const [source, target] = await Promise.all([freshDatabase(t), freshDatabase(t, { migrate: false })]);
  source.psql(SEED);
  const bundleDir = join(tmp, "bundle");
  await exportBundle(session(t, source), bundleDir);

  // Corpus data the restore must not touch, in a target with no ranker role yet.
  target.psql("create table corpora (id text primary key, name text); insert into corpora values ('cr_corpus_mine', 'mine');");
  const found = target.psql(STATE);
  const rows = target.psql("select json_agg(c order by id) from corpora c");

  await assert.rejects(restoreBundle(session(t, target), bundleDir), /restore target database "ranker" is not empty/);
  assert.equal(target.psql(STATE), found);
  assert.equal(target.psql("select json_agg(c order by id) from corpora c"), rows);
  assert.equal(target.psql("select count(*) from pg_roles where rolname = 'ranker_app'"), "0");

  // A migrated target holding the corpus itself is refused the same way.
  const sourceFound = source.psql(STATE);
  await assert.rejects(restoreBundle(session(t, source), bundleDir), /restore target database "ranker" is not empty/);
  assert.equal(source.psql(STATE), sourceFound);
  assert.equal(source.psql("select count(*) from items"), "2");
});

// CR-M3-BUNDLE-V1: a version-1 bundle as the exporter wrote it before
// --inserts (commit 5e65122: a plain pg_dump whose table data is COPY ... FROM
// stdin blocks), generated once and committed. Restore must keep loading it,
// whatever restore path or dump encoding follows; see fixtures/README.md.
const V1_COPY_BUNDLE = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "bundle-v1-copy");

test("a committed version-1 bundle whose dump carries COPY FROM stdin data restores into an empty database and reproduces its JSONL hashes", { timeout: 900_000 }, async (t) => {
  // The fixture is what it claims to be: version 1, its files as the
  // manifest lists them, and its table data in COPY blocks, not INSERTs.
  const manifest = verifyBundle(V1_COPY_BUNDLE);
  assert.equal(manifest.bundle_version, 1);
  assert.equal(BUNDLE_VERSION, 1);
  const dump = readFileSync(join(V1_COPY_BUNDLE, "database.sql"), "utf8");
  const copies = dump.match(/^COPY public\.\w+ \(.*\) FROM stdin;$/gm) ?? [];
  for (const table of ["corpora", "originals", "items", "score_events", "tombstones"]) {
    assert.ok(copies.some((c) => c.startsWith(`COPY public.${table} (`)), `fixture dump carries ${table} as COPY data`);
  }
  assert.doesNotMatch(dump, /^INSERT INTO /m, "fixture dump carries no INSERT statements");

  const tmp = mkdtempSync(join(tmpdir(), "cr-restore-v1-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const target = await freshDatabase(t, { migrate: false });
  const found = target.psql(STATE);

  // Atomic: a copy that fails after every COPY block has loaded (a row
  // duplicated in the last block breaks the primary key pg_dump builds after
  // the data) leaves the target as found (empty).
  const broken = join(tmp, "broken");
  cpSync(V1_COPY_BUNDLE, broken, { recursive: true });
  rewrite(broken, "database.sql", (s) => s.replace(/^(COPY public\.tombstones .* FROM stdin;\n)(.*\n)/m, "$1$2$2"));
  await assert.rejects(restoreBundle(session(t, target), broken), /could not create unique index "tombstones_pkey"/);
  assert.equal(target.psql(STATE), found, "failed load leaves the target as found");

  // The committed bundle itself restores and reproduces every JSONL hash
  // (restoreBundle re-derives them inside its transaction); check again here.
  assert.deepEqual(await restoreBundle(session(t, target), V1_COPY_BUNDLE), manifest);
  const out = join(tmp, "re-export");
  const again = await exportBundle(session(t, target), out);
  for (const [file, meta] of Object.entries(manifest.files)) {
    if (file.endsWith(".jsonl")) assert.equal(again.files[file]?.sha256, meta.sha256, `${file} reproduced`);
  }
  assert.deepEqual(again.counts, manifest.counts);
  assert.equal(again.schema_version, manifest.schema_version);
});
