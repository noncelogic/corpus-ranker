// CR-M2-T4 acceptance: one command produces the SPEC A5 export bundle
// (database dump plus JSONL of Items, Scores, Policies and the Originals
// manifest) such that a fresh instance restores the corpus from the bundle
// alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadContracts, schemaUri } from "../../src/contracts/index.ts";
import { BUNDLE_VERSION, exportBundle, restoreBundle, type PgSession } from "../../src/export/bundle.ts";
import { freshDatabase, type FreshDb } from "../schema/fresh-db.ts";

const H = (c: string) => c.repeat(64);
const session = (db: FreshDb): PgSession => ({ query: db.psql, dump: db.pgDump });

// A small corpus touching every A2 table, with awkward text (quotes, newline,
// unicode) to exercise JSON escaping, a tombstoned Original, a retracted
// Score, a superseding Policy version, a cross-system and a reversed edge.
const SEED = `
insert into corpora (id, name, description, taxonomy_id, status, created_at)
  values ('cr_corpus_papers01', 'papers', 'AI papers', 'cr_tax_papers01', 'active', '2026-11-01T00:00:00Z');
insert into originals (id, corpus_id, content_hash, media_type, byte_size, storage_uri, source, raw_metadata, captured_at, tombstoned_at, tombstone_reason)
  values ('cr_orig_a1', 'cr_corpus_papers01', '${H("a")}', 'application/pdf', 10, 's3://ranker-originals/${H("a")}',
          '{"source_kind":"feed","source":"https://export.arxiv.org/rss/cs.AI","recorded_by":"agent:intake-arxiv","at":"2026-11-03T08:00:00Z","hash":"${H("a")}"}',
          '{"arxiv_id":"2611.01234"}', '2026-11-03T08:00:00Z', null, null),
         ('cr_orig_b2', 'cr_corpus_papers01', '${H("b")}', 'application/json', 20, 's3://ranker-originals/${H("b")}',
          '{"source_kind":"url","source":"https://arxiv.org/abs/2611.01234v2","recorded_by":"joe","at":"2026-11-05T12:30:00Z","hash":"${H("b")}"}',
          '{}', '2026-11-05T12:30:00Z', null, null),
         ('cr_orig_c3', 'cr_corpus_papers01', '${H("c")}', 'application/pdf', 30, 's3://ranker-originals/${H("c")}',
          '{"source_kind":"upload","source":"papers-2026-W45.jsonl","recorded_by":"agent:import-jsonl","at":"2026-11-06T00:00:00Z"}',
          '{}', '2026-11-06T00:00:00Z', '2026-11-08T10:00:00Z', 'verified forgetting requested by joe');
insert into items (id, corpus_id, item_type, title, summary, canonical_fields, identity_keys, status, created_at, updated_at)
  values ('cr_item_p1', 'cr_corpus_papers01', 'paper', 'Context "Management" for Long-Horizon Agents',
          E'Line one.\\nLine two — with ünïcode and a back\\\\slash.', '{"authors":["A. Author"]}',
          '{"arxiv_id":"2611.01234"}', 'active', '2026-11-03T08:00:00Z', '2026-11-05T12:30:00.123456Z'),
         ('cr_item_p2', 'cr_corpus_papers01', 'paper', 'Paper Two', null, '{}',
          '{"arxiv_id":"2611.02345"}', 'tombstoned', '2026-11-06T00:00:00Z', '2026-11-08T10:00:00Z');
insert into item_originals (item_id, original_id)
  values ('cr_item_p1', 'cr_orig_a1'), ('cr_item_p1', 'cr_orig_b2'), ('cr_item_p2', 'cr_orig_c3');
insert into classifications (id, item_id, taxonomy_version, labels, status, proposed_by, proposed_at, committed_by, committed_at, confidence, rationale)
  values ('cr_cls_c1', 'cr_item_p1', 1, '{research/context-management}', 'committed', 'agent:classifier',
          '2026-11-04T00:00:00Z', 'joe', '2026-11-04T01:00:00Z', 0.82, 'Agent memory.');
insert into edges (id, from_id, to_id, to_system, edge_type, created_by, created_at, evidence, reversed_at, reversed_by)
  values ('cr_edge_e1', 'cr_item_p1', 'cr_item_p2', 'corpus-ranker', 'cites', 'agent:citation-extractor',
          '2026-11-07T11:00:00Z', '{"id":"cr_orig_a1","span":{"start":10,"end":20}}', null, null),
         ('cr_edge_e2', 'cr_item_p1', 'lc_loop_42', 'loop-closer', 'evidences', 'joe', '2026-11-07T12:00:00Z', null, null, null),
         ('cr_edge_e3', 'cr_item_p2', 'cr_item_p1', 'corpus-ranker', 'same_as', 'agent:dedup',
          '2026-11-07T12:00:00Z', null, '2026-11-07T13:00:00Z', 'joe');
insert into policies (id, version, name, corpus_id, dimensions, judge_config, composite_rule, created_by, created_at, supersedes_version)
  select 'cr_pol_paper', v, 'paper-rubric', 'cr_corpus_papers01',
         '[{"name":"Relevance","scale":{"kind":"integer","min":1,"max":5},"definition":{"1":"No.","5":"Yes."},"weight":1,"judge_instructions":"Score it."},
           {"name":"Technical Merit","scale":{"kind":"integer","min":1,"max":5},"definition":{"1":"No.","5":"Yes."},"weight":1,"judge_instructions":"Score it."}]',
         '{"allowed_scorers":[{"kind":"human","identity":"joe"}],"source_blind":false}',
         '{"method":"weighted_sum","tie_breaks":["Relevance"]}',
         'joe', ('2026-11-0' || v || 'T08:00:00Z')::timestamptz, nullif(v - 1, 0)
    from generate_series(1, 2) v;
insert into score_events (id, item_id, policy_id, policy_version, dimension_scores, scorer, scored_at, source_blind, recorded_at)
  values ('cr_score_s1', 'cr_item_p1', 'cr_pol_paper', 1,
          '[{"dimension":"Relevance","value":5,"reason":"On target.","evidence":[]},{"dimension":"Technical Merit","value":4,"reason":"Solid.","evidence":[]}]',
          '{"identity":"joe"}', '2026-10-10T00:00:00Z', false, '2026-11-09T00:00:00Z'),
         ('cr_score_s2', 'cr_item_p1', 'cr_pol_paper', 1,
          '[{"dimension":"Relevance","value":1,"reason":"Wrong PDF.","evidence":[]},{"dimension":"Technical Merit","value":1,"reason":"Wrong PDF.","evidence":[]}]',
          '{"identity":"program:paper-judge","model":"claude-opus-5-5"}', '2026-10-11T00:00:00Z', true, '2026-11-09T00:00:01Z'),
         ('cr_score_s3', 'cr_item_p1', 'cr_pol_paper', 2,
          '[{"dimension":"Relevance","value":4,"reason":"Replayed.","evidence":[]},{"dimension":"Technical Merit","value":4,"reason":"Replayed.","evidence":[]}]',
          '{"identity":"joe"}', '2026-11-09T00:00:00Z', false, '2026-11-09T00:00:02Z');
insert into score_retractions (score_event_id, retracted_at, retracted_by, retraction_reason)
  values ('cr_score_s2', '2026-11-09T01:00:00Z', 'joe', 'Judge read the wrong PDF.');
insert into ranked_views (id, name, corpus_id, policy_id, policy_version, query, computed_at, stale, stale_reason)
  values ('cr_view_v1', 'daily-top-papers', 'cr_corpus_papers01', 'cr_pol_paper', 1,
          '{"subject":"agent context management"}', '2026-11-09T02:00:00Z', true, 'Policy paper-rubric v2 created.');
insert into ranked_view_entries (view_id, rank, item_id, composite, score_event_ids)
  values ('cr_view_v1', 1, 'cr_item_p1', 9, '{cr_score_s1}');
insert into ranked_view_actions (view_id, item_id, action_type, actor, at)
  values ('cr_view_v1', 'cr_item_p1', 'picked', 'joe', '2026-11-09T03:00:00Z');
insert into tombstones (id, target_id, reason, actor, tombstoned_at, preserved, tombstoned_item_ids, stale_view_ids)
  values ('cr_tomb_t1', 'cr_orig_c3', 'verified forgetting requested by joe', 'joe', '2026-11-08T10:00:00Z',
          '[{"original_id":"cr_orig_c3","content_hash":"${H("c")}","source":{"source_kind":"upload","source":"papers-2026-W45.jsonl","recorded_by":"agent:import-jsonl","at":"2026-11-06T00:00:00Z"}}]', '{cr_item_p2}', '{}');
insert into embeddings (item_id, chunk_id, embedding_model_id, model_version, dims, vector, source_hash)
  values ('cr_item_p1', null, 'text-embedding-3-small', '1', 3, '[0.1,0.2,0.3]', '${H("a")}');
`;

// Every table of the corpus model whose rows are the record (embeddings are
// derived and deliberately left out of the bundle, SPEC A5).
const RECORD_TABLES = [
  ["corpora", "id"],
  ["originals", "id"],
  ["items", "id"],
  ["item_originals", "item_id, original_id"],
  ["classifications", "id"],
  ["edges", "id"],
  ["policies", "id, version"],
  ["score_events", "id"],
  ["score_retractions", "score_event_id"],
  ["ranked_views", "id"],
  ["ranked_view_entries", "view_id, rank"],
  ["ranked_view_actions", "id"],
  ["tombstones", "id"],
  ["schema_migrations", "version"],
] as const;

const snapshot = (db: FreshDb, table: string, order: string) =>
  db.psql(`select coalesce(json_agg(t order by ${order}), '[]') from ${table} t`);

const readJsonl = (dir: string, file: string): Record<string, unknown>[] =>
  readFileSync(join(dir, file), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));

const contracts = loadContracts();

test("export then restore into a fresh database reproduces the corpus", { timeout: 900_000 }, async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "cr-export-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const [source, fresh] = await Promise.all([freshDatabase(t), freshDatabase(t, { migrate: false })]);
  source.psql(SEED);

  // One command produces the bundle.
  const bundleDir = join(tmp, "bundle");
  const manifest = exportBundle(session(source), bundleDir, { now: () => new Date("2026-11-10T00:00:00Z") });

  // manifest.json: version, export time, counts, hashes of every file.
  assert.deepEqual(JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8")), manifest);
  assert.equal(manifest.bundle_version, BUNDLE_VERSION);
  assert.equal(manifest.exported_at, "2026-11-10T00:00:00.000Z");
  assert.equal(manifest.schema_version, 1);
  assert.deepEqual(manifest.counts, {
    corpora: 1, originals: 3, items: 2, classifications: 1, edges: 3,
    policies: 2, scores: 3, views: 1, tombstones: 1,
  });
  assert.deepEqual(readdirSync(bundleDir).sort(), [...Object.keys(manifest.files), "manifest.json"].sort());
  for (const [file, meta] of Object.entries(manifest.files)) {
    const bytes = readFileSync(join(bundleDir, file));
    assert.equal(meta.sha256, createHash("sha256").update(bytes).digest("hex"), file);
    assert.equal(meta.bytes, bytes.length, file);
  }
  assert.match(readFileSync(join(bundleDir, "database.sql"), "utf8"), /PostgreSQL database dump/);

  // JSONL: one contract-valid object per line, IDs preserved.
  const SCHEMAS: Record<string, string> = {
    "corpora.jsonl": "corpus.schema.json",
    "originals.jsonl": "original.schema.json",
    "items.jsonl": "item.schema.json",
    "classifications.jsonl": "classification.schema.json",
    "edges.jsonl": "edge.schema.json",
    "policies.jsonl": "policy.schema.json",
    "scores.jsonl": "score-event.schema.json",
    "views.jsonl": "ranked-view.schema.json",
    "tombstones.jsonl": "tombstone.schema.json",
  };
  for (const [file, schema] of Object.entries(SCHEMAS)) {
    for (const o of readJsonl(bundleDir, file)) {
      assert.deepEqual(contracts.registry.validate(o, schemaUri(schema)), [], `${file} ${String(o.id)}`);
    }
  }
  const items = readJsonl(bundleDir, "items.jsonl");
  assert.deepEqual(items.map((i) => i.id), ["cr_item_p1", "cr_item_p2"]);
  assert.equal(items[0]!.title, 'Context "Management" for Long-Horizon Agents');
  assert.equal(items[0]!.summary, "Line one.\nLine two — with ünïcode and a back\\slash.");
  assert.deepEqual(items[0]!.original_ids, ["cr_orig_a1", "cr_orig_b2"]);
  assert.equal(items[0]!.updated_at, "2026-11-05T12:30:00.123456Z");
  assert.deepEqual(readJsonl(bundleDir, "originals.jsonl").map((o) => [o.id, o.content_hash, o.storage_uri, o.tombstoned_at]), [
    ["cr_orig_a1", H("a"), `s3://ranker-originals/${H("a")}`, null],
    ["cr_orig_b2", H("b"), `s3://ranker-originals/${H("b")}`, null],
    ["cr_orig_c3", H("c"), `s3://ranker-originals/${H("c")}`, "2026-11-08T10:00:00.000000Z"],
  ]);
  const scores = readJsonl(bundleDir, "scores.jsonl");
  assert.deepEqual(scores.map((s) => [s.id, s.policy_version, s.retraction_reason]), [
    ["cr_score_s1", 1, null],
    ["cr_score_s2", 1, "Judge read the wrong PDF."],
    ["cr_score_s3", 2, null],
  ]);
  assert.deepEqual(readJsonl(bundleDir, "policies.jsonl").map((p) => [p.id, p.version, p.supersedes_version]), [
    ["cr_pol_paper", 1, null],
    ["cr_pol_paper", 2, 1],
  ]);
  assert.deepEqual(readJsonl(bundleDir, "edges.jsonl")[1]!.to_id, { system: "loop-closer", id: "lc_loop_42" });
  const [view] = readJsonl(bundleDir, "views.jsonl");
  assert.deepEqual(view!.entries, [{ item_id: "cr_item_p1", rank: 1, composite: 9, score_event_ids: ["cr_score_s1"] }]);
  assert.deepEqual(view!.action_events, [{ item_id: "cr_item_p1", action_type: "picked", actor: "joe", at: "2026-11-09T03:00:00.000000Z" }]);

  // A tampered bundle is refused before anything is loaded.
  const tampered = join(tmp, "tampered");
  exportBundle(session(source), tampered);
  writeFileSync(join(tampered, "items.jsonl"), readFileSync(join(tampered, "items.jsonl"), "utf8").replace("Paper Two", "Paper 2"));
  assert.throws(() => restoreBundle(session(fresh), tampered), /items\.jsonl: sha256 mismatch/);
  assert.equal(fresh.psql("select count(*) from pg_tables where schemaname = 'public'"), "0");

  // The fresh instance (no migrations, no prior data) restores from the bundle alone.
  const restored = restoreBundle(session(fresh), bundleDir);
  assert.deepEqual(restored, manifest);

  // Every record table is reproduced row for row; derived embeddings are not carried.
  for (const [table, order] of RECORD_TABLES) {
    assert.equal(snapshot(fresh, table, order), snapshot(source, table, order), table);
  }
  assert.equal(fresh.psql("select count(*) from embeddings"), "0");

  // The live ranking inputs answer the same: live scores per policy version.
  const live = "select string_agg(id, ',' order by id) from score_events_with_retraction where retracted_at is null";
  assert.equal(fresh.psql(live), "cr_score_s1,cr_score_s3");

  // The append-only guarantees come back with the data.
  assert.throws(() => fresh.psqlAs("ranker_app", "update score_events set source_blind = true"), /permission denied/);
  assert.equal(fresh.psqlAs("ranker_app", "select count(*) from items"), "2");

  // Re-exporting the restored instance yields byte-identical records.
  const again = exportBundle(session(fresh), join(tmp, "again"), { now: () => new Date("2026-11-10T00:00:00Z") });
  for (const file of Object.keys(SCHEMAS)) assert.equal(again.files[file]!.sha256, manifest.files[file]!.sha256, file);
  assert.deepEqual(again.counts, manifest.counts);

  // Restore refuses a target that already holds a schema.
  assert.throws(() => restoreBundle(session(fresh), bundleDir), /not empty/);
});
