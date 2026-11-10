// CR-M1-T3 acceptance: the versioned schema files create the SPEC A2 corpus
// model on a fresh database: corpus tables, pgvector embeddings keyed by
// model id + version, and typed edge tables holding the citation graph.
import { test } from "node:test";
import assert from "node:assert/strict";
import { listMigrations } from "../../src/db/migrations.ts";
import { freshDatabase } from "./fresh-db.ts";

const A2_TABLES = [
  "corpora",
  "originals",
  "items",
  "item_originals",
  "classifications",
  "edges",
  "policies",
  "score_events",
  "score_retractions",
  "ranked_views",
  "ranked_view_entries",
  "ranked_view_actions",
  "tombstones",
  "embeddings",
];

test("migration files are versioned, contiguous and ordered", () => {
  const ms = listMigrations();
  assert.ok(ms.length >= 1, "at least one migration");
  ms.forEach((m, i) => {
    assert.equal(m.version, i + 1, `${m.file} must be version ${i + 1}`);
    assert.match(m.name, /^[a-z0-9_]+$/);
    assert.ok(m.sql.trim().length > 0, `${m.file} is empty`);
  });
});

test("migrations create the A2 tables on a fresh database", { timeout: 600_000 }, async (t) => {
  const db = await freshDatabase(t);
  const q = db.psql;

  // Versions recorded.
  const applied = q("select version from schema_migrations order by version").split("\n").map(Number);
  assert.deepEqual(applied, listMigrations().map((m) => m.version));

  // Every A2 table exists in the public schema.
  const tables = new Set(
    q("select table_name from information_schema.tables where table_schema = 'public'").split("\n"),
  );
  for (const name of A2_TABLES) assert.ok(tables.has(name), `missing table ${name}`);

  // Corpus -> Original -> Item chain, Policy, Score event round trip.
  q(`
    insert into corpora (id, name, description, taxonomy_id, status)
      values ('cr_corpus_papers', 'papers', 'AI papers', 'cr_tax_papers1', 'active');
    insert into originals (id, corpus_id, content_hash, media_type, byte_size, storage_uri, source, raw_metadata)
      values ('cr_orig_a1', 'cr_corpus_papers', repeat('a', 64), 'application/pdf', 10,
              's3://ranker-originals/' || repeat('a', 64),
              '{"source_kind":"feed","source":"arxiv","recorded_by":"agent:intake","at":"2026-11-01T00:00:00Z"}', '{}');
    insert into items (id, corpus_id, item_type, title, canonical_fields, identity_keys, status)
      values ('cr_item_p1', 'cr_corpus_papers', 'paper', 'Paper One', '{}', '{"arxiv_id":"2601.00001"}', 'active'),
             ('cr_item_p2', 'cr_corpus_papers', 'paper', 'Paper Two', '{}', '{"arxiv_id":"2601.00002"}', 'active'),
             ('cr_item_p3', 'cr_corpus_papers', 'paper', 'Paper Three', '{}', '{"arxiv_id":"2601.00003"}', 'active');
    insert into item_originals (item_id, original_id) values ('cr_item_p1', 'cr_orig_a1');
    insert into policies (id, version, name, corpus_id, dimensions, judge_config, composite_rule, created_by)
      values ('cr_pol_rubric', 1, 'paper-rubric', 'cr_corpus_papers',
              '[{"name":"Relevance"}]', '{"allowed_scorers":[],"source_blind":false}',
              '{"method":"weighted_sum","tie_breaks":[]}', 'joe');
    insert into score_events (id, item_id, policy_id, policy_version, dimension_scores, scorer, scored_at, source_blind)
      values ('cr_score_s1', 'cr_item_p1', 'cr_pol_rubric', 1,
              '[{"dimension":"Relevance","value":5,"reason":"on topic","evidence":[]}]',
              '{"identity":"joe"}', '2026-11-01T00:00:00Z', false);
  `);
  assert.equal(q("select count(*) from score_events where policy_version = 1"), "1");

  // Constraints: unknown status rejected; score must cite an existing policy version.
  assert.throws(() =>
    q(`insert into corpora (id, name, description, taxonomy_id, status)
         values ('cr_corpus_x', 'x', '', 'cr_tax_x', 'bogus')`),
  );
  assert.throws(() =>
    q(`insert into score_events (id, item_id, policy_id, policy_version, dimension_scores, scorer, scored_at, source_blind)
         values ('cr_score_s2', 'cr_item_p1', 'cr_pol_rubric', 2, '[]', '{"identity":"joe"}', now(), false)`),
  );

  // pgvector: embeddings keyed by item (+chunk) + embedding_model_id + model_version.
  q(`
    insert into embeddings (item_id, chunk_id, embedding_model_id, model_version, dims, vector, source_hash)
      values ('cr_item_p1', null, 'text-embed', '1', 3, '[1,0,0]', repeat('b', 64)),
             ('cr_item_p1', null, 'text-embed', '2', 3, '[0,1,0]', repeat('b', 64)),
             ('cr_item_p1', null, 'other-model', '1', 2, '[0,1]', repeat('b', 64)),
             ('cr_item_p2', null, 'text-embed', '1', 3, '[0.9,0.1,0]', repeat('c', 64));
  `);
  assert.equal(
    q(`select data_type || '/' || udt_name from information_schema.columns
         where table_name = 'embeddings' and column_name = 'vector'`),
    "USER-DEFINED/vector",
  );
  // Same item, model and version twice is a key violation; a new version coexists.
  assert.throws(() =>
    q(`insert into embeddings (item_id, chunk_id, embedding_model_id, model_version, dims, vector, source_hash)
         values ('cr_item_p1', null, 'text-embed', '1', 3, '[0,0,1]', repeat('d', 64))`),
  );
  // dims must match the stored vector.
  assert.throws(() =>
    q(`insert into embeddings (item_id, chunk_id, embedding_model_id, model_version, dims, vector, source_hash)
         values ('cr_item_p3', null, 'text-embed', '1', 4, '[0,0,1]', repeat('d', 64))`),
  );
  assert.equal(
    q(`select item_id from embeddings
         where embedding_model_id = 'text-embed' and model_version = '1'
         order by vector <=> '[1,0,0]' limit 1 offset 1`),
    "cr_item_p2",
  );

  // Edge table: typed citation graph, traversable with a recursive CTE.
  q(`
    insert into edges (id, from_id, to_id, edge_type, created_by)
      values ('cr_edge_1', 'cr_item_p1', 'cr_item_p2', 'cites', 'agent:refs'),
             ('cr_edge_2', 'cr_item_p2', 'cr_item_p3', 'cites', 'agent:refs'),
             ('cr_edge_3', 'cr_item_p1', 'cr_item_p3', 'same_as', 'joe');
    insert into edges (id, from_id, to_id, to_system, edge_type, created_by)
      values ('cr_edge_4', 'cr_item_p1', 'lc_loop_9', 'loop-closer', 'evidences', 'joe');
  `);
  assert.throws(() =>
    q(`insert into edges (id, from_id, to_id, edge_type, created_by)
         values ('cr_edge_5', 'cr_item_p1', 'cr_item_p2', 'likes', 'joe')`),
  );
  const reachable = q(`
    with recursive cited(id) as (
      select to_id from edges where from_id = 'cr_item_p1' and edge_type = 'cites' and reversed_at is null
      union
      select e.to_id from edges e join cited c on e.from_id = c.id
        where e.edge_type = 'cites' and e.reversed_at is null
    ) select id from cited order by id`);
  assert.deepEqual(reachable.split("\n"), ["cr_item_p2", "cr_item_p3"]);
});
