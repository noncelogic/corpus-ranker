-- 0001 corpus model: SPEC A2 tables for the ranker's own database.
--
-- Applied inside one transaction by the migration runner. The migration owner
-- owns every table; the service connects as (or SET ROLE to) ranker_app,
-- whose grants make Score events, retractions, Policy versions, view
-- entries and view action events append-only (TECH-STACK §2).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE schema_migrations (
  version    integer PRIMARY KEY,
  name       text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- The application role. NOLOGIN here: credentials are deployment's concern
-- (CR-D1), which grants this role to the service's login user.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ranker_app') THEN
    CREATE ROLE ranker_app NOLOGIN;
  END IF;
END
$$;

-- Agent identity (contracts common.schema.json#/$defs/agent_identity).
CREATE DOMAIN agent_identity AS text
  CHECK (VALUE ~ '^[a-z][a-z0-9._-]*(:[a-z0-9][a-z0-9._-]*)?$' AND length(VALUE) <= 200);

CREATE DOMAIN sha256_hex AS text
  CHECK (VALUE ~ '^[a-f0-9]{64}$');

-- A2.1 Corpus
CREATE TABLE corpora (
  id          text PRIMARY KEY CHECK (id ~ '^cr_corpus_[A-Za-z0-9]+$'),
  name        text NOT NULL UNIQUE CHECK (name ~ '^[a-z][a-z0-9-]*$'),
  description text NOT NULL DEFAULT '',
  taxonomy_id text NOT NULL CHECK (taxonomy_id ~ '^cr_tax_[A-Za-z0-9]+$'),
  created_at  timestamptz NOT NULL DEFAULT now(),
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived'))
);

-- A2.2 Original: immutable evidence; removed only by tombstoning, which keeps
-- the hash and provenance.
CREATE TABLE originals (
  id               text PRIMARY KEY CHECK (id ~ '^cr_orig_[A-Za-z0-9]+$'),
  corpus_id        text NOT NULL REFERENCES corpora (id),
  content_hash     sha256_hex NOT NULL,
  media_type       text NOT NULL CHECK (media_type ~ '^[a-z]+/[a-zA-Z0-9.+_-]+$'),
  byte_size        bigint NOT NULL CHECK (byte_size >= 0),
  storage_uri      text NOT NULL,
  source           jsonb NOT NULL CHECK (jsonb_typeof(source) = 'object'),
  raw_metadata     jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(raw_metadata) = 'object'),
  captured_at      timestamptz NOT NULL DEFAULT now(),
  tombstoned_at    timestamptz,
  tombstone_reason text,
  -- capture dedups on hash within a corpus.
  UNIQUE (corpus_id, content_hash),
  CHECK ((tombstoned_at IS NULL AND tombstone_reason IS NULL)
      OR (tombstoned_at IS NOT NULL AND length(tombstone_reason) > 0))
);

-- A2.3 Item
CREATE TABLE items (
  id               text PRIMARY KEY CHECK (id ~ '^cr_item_[A-Za-z0-9]+$'),
  corpus_id        text NOT NULL REFERENCES corpora (id),
  item_type        text NOT NULL CHECK (item_type ~ '^[a-z][a-z0-9_-]*$'),
  title            text NOT NULL CHECK (length(title) > 0),
  summary          text,
  canonical_fields jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(canonical_fields) = 'object'),
  identity_keys    jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(identity_keys) = 'object'),
  status           text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'merged', 'superseded', 'tombstoned')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX items_corpus_idx ON items (corpus_id, item_type);
CREATE INDEX items_identity_keys_idx ON items USING gin (identity_keys jsonb_path_ops);

-- A2.3 Item.original_ids[]: the Originals an Item rests on.
CREATE TABLE item_originals (
  item_id     text NOT NULL REFERENCES items (id),
  original_id text NOT NULL REFERENCES originals (id),
  PRIMARY KEY (item_id, original_id)
);
CREATE INDEX item_originals_original_idx ON item_originals (original_id);

-- A2.4 Classification: proposed, then committed; reclassification is a new row.
CREATE TABLE classifications (
  id               text PRIMARY KEY CHECK (id ~ '^cr_cls_[A-Za-z0-9]+$'),
  item_id          text NOT NULL REFERENCES items (id),
  taxonomy_version integer NOT NULL CHECK (taxonomy_version >= 1),
  labels           text[] NOT NULL CHECK (cardinality(labels) >= 1),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'committed')),
  proposed_by      agent_identity NOT NULL,
  proposed_at      timestamptz NOT NULL DEFAULT now(),
  committed_by     agent_identity,
  committed_at     timestamptz,
  confidence       double precision NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  rationale        text NOT NULL DEFAULT '',
  CHECK ((status = 'pending' AND committed_by IS NULL AND committed_at IS NULL)
      OR (status = 'committed' AND committed_by IS NOT NULL AND committed_at IS NOT NULL))
);
CREATE INDEX classifications_item_idx ON classifications (item_id);

-- A2.5 Edges: the typed graph (citation graph included), traversed with
-- recursive CTEs (TECH-STACK §4). from_id is any Ranker id; to_id is a Ranker
-- id or, when to_system = 'loop-closer', a cross-reference. same_as merges
-- are reversed by recording reversed_at/by, never by deleting the edge.
CREATE TABLE edges (
  id          text PRIMARY KEY CHECK (id ~ '^cr_edge_[A-Za-z0-9]+$'),
  from_id     text NOT NULL CHECK (from_id ~ '^cr_(corpus|tax|orig|item|cls|edge|pol|score|view|tomb)_[A-Za-z0-9]+$'),
  to_id       text NOT NULL CHECK (length(to_id) > 0),
  to_system   text NOT NULL DEFAULT 'corpus-ranker' CHECK (to_system IN ('corpus-ranker', 'loop-closer')),
  edge_type   text NOT NULL CHECK (edge_type IN (
                'cites', 'derived_from', 'same_as', 'supersedes', 'evidences',
                'classified_under', 'part_of', 'artifact')),
  created_by  agent_identity NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  evidence    jsonb CHECK (evidence IS NULL OR jsonb_typeof(evidence) = 'object'),
  provenance  jsonb CHECK (provenance IS NULL OR jsonb_typeof(provenance) = 'object'),
  reversed_at timestamptz,
  reversed_by agent_identity,
  CHECK (to_system <> 'corpus-ranker'
      OR to_id ~ '^cr_(corpus|tax|orig|item|cls|edge|pol|score|view|tomb)_[A-Za-z0-9]+$'),
  CHECK ((reversed_at IS NULL) = (reversed_by IS NULL))
);
CREATE INDEX edges_from_idx ON edges (from_id, edge_type);
CREATE INDEX edges_to_idx ON edges (to_id, edge_type);

-- A2.6 Policy: one row per (id, version); a new version is a new row.
CREATE TABLE policies (
  id                 text NOT NULL CHECK (id ~ '^cr_pol_[A-Za-z0-9]+$'),
  version            integer NOT NULL CHECK (version >= 1),
  name               text NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]*$'),
  corpus_id          text NOT NULL REFERENCES corpora (id),
  dimensions         jsonb NOT NULL CHECK (jsonb_typeof(dimensions) = 'array' AND jsonb_array_length(dimensions) >= 1),
  judge_config       jsonb NOT NULL CHECK (jsonb_typeof(judge_config) = 'object'),
  composite_rule     jsonb NOT NULL CHECK (jsonb_typeof(composite_rule) = 'object'),
  created_by         agent_identity NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  supersedes_version integer CHECK (supersedes_version >= 1 AND supersedes_version < version),
  PRIMARY KEY (id, version),
  FOREIGN KEY (id, supersedes_version) REFERENCES policies (id, version)
);

-- A2.7 Score event: append-only. Never updated; retraction is a separate
-- appended row in score_retractions.
CREATE TABLE score_events (
  id               text PRIMARY KEY CHECK (id ~ '^cr_score_[A-Za-z0-9]+$'),
  item_id          text NOT NULL REFERENCES items (id),
  policy_id        text NOT NULL,
  policy_version   integer NOT NULL,
  dimension_scores jsonb NOT NULL CHECK (jsonb_typeof(dimension_scores) = 'array' AND jsonb_array_length(dimension_scores) >= 1),
  scorer           jsonb NOT NULL CHECK (jsonb_typeof(scorer) = 'object' AND scorer ? 'identity'),
  scored_at        timestamptz NOT NULL,
  source_blind     boolean NOT NULL,
  recorded_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (policy_id, policy_version) REFERENCES policies (id, version)
);
CREATE INDEX score_events_item_idx ON score_events (item_id, policy_id, policy_version);

CREATE TABLE score_retractions (
  score_event_id    text PRIMARY KEY REFERENCES score_events (id),
  retracted_at      timestamptz NOT NULL DEFAULT now(),
  retracted_by      agent_identity NOT NULL,
  retraction_reason text NOT NULL CHECK (length(retraction_reason) > 0)
);

-- The Score event as the contract shapes it (retracted_* fields inline).
CREATE VIEW score_events_with_retraction AS
  SELECT s.id, s.item_id, s.policy_id, s.policy_version, s.dimension_scores, s.scorer,
         s.scored_at, s.source_blind, r.retracted_at, r.retracted_by, r.retraction_reason
    FROM score_events s
    LEFT JOIN score_retractions r ON r.score_event_id = s.id;

-- A2.8 Ranked View: a saved derivation. Entries and action events are
-- append-only; only the stale marker changes after creation.
CREATE TABLE ranked_views (
  id             text PRIMARY KEY CHECK (id ~ '^cr_view_[A-Za-z0-9]+$'),
  name           text NOT NULL CHECK (length(name) > 0),
  corpus_id      text NOT NULL REFERENCES corpora (id),
  policy_id      text NOT NULL,
  policy_version integer NOT NULL,
  query          jsonb NOT NULL CHECK (jsonb_typeof(query) = 'object' AND query <> '{}'),
  computed_at    timestamptz NOT NULL DEFAULT now(),
  stale          boolean NOT NULL DEFAULT false,
  stale_reason   text,
  FOREIGN KEY (policy_id, policy_version) REFERENCES policies (id, version),
  CHECK ((NOT stale AND stale_reason IS NULL) OR (stale AND length(stale_reason) > 0))
);

CREATE TABLE ranked_view_entries (
  view_id         text NOT NULL REFERENCES ranked_views (id),
  rank            integer NOT NULL CHECK (rank >= 1),
  item_id         text NOT NULL REFERENCES items (id),
  composite       double precision NOT NULL,
  score_event_ids text[] NOT NULL CHECK (cardinality(score_event_ids) >= 1),
  PRIMARY KEY (view_id, rank),
  UNIQUE (view_id, item_id)
);

CREATE TABLE ranked_view_actions (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  view_id     text NOT NULL REFERENCES ranked_views (id),
  item_id     text NOT NULL REFERENCES items (id),
  action_type text NOT NULL CHECK (action_type IN ('picked', 'promoted', 'pursued', 'rejected')),
  actor       agent_identity NOT NULL,
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ranked_view_actions_view_idx ON ranked_view_actions (view_id);

-- A2.9 Tombstone: the record of verified forgetting.
CREATE TABLE tombstones (
  id                  text PRIMARY KEY CHECK (id ~ '^cr_tomb_[A-Za-z0-9]+$'),
  target_id           text NOT NULL CHECK (target_id ~ '^cr_(orig|item)_[A-Za-z0-9]+$'),
  reason              text NOT NULL CHECK (length(reason) > 0),
  actor               agent_identity NOT NULL,
  tombstoned_at       timestamptz NOT NULL DEFAULT now(),
  preserved           jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(preserved) = 'array'),
  tombstoned_item_ids text[] NOT NULL DEFAULT '{}',
  stale_view_ids      text[] NOT NULL DEFAULT '{}'
);

-- A2.10 Embedding record: derived and disposable. Keyed by item (+ chunk),
-- embedding_model_id and model_version so several models coexist during a
-- changeover (TECH-STACK §3, §7). The column is dimension-agnostic; an ANN
-- index needs fixed dims, so one is created per adopted model, e.g.
--   CREATE INDEX ... USING hnsw ((vector::vector(1536)) vector_cosine_ops)
--     WHERE embedding_model_id = '...' AND model_version = '...';
CREATE TABLE embeddings (
  item_id            text NOT NULL REFERENCES items (id) ON DELETE CASCADE,
  chunk_id           text CHECK (chunk_id IS NULL OR length(chunk_id) > 0),
  embedding_model_id text NOT NULL CHECK (length(embedding_model_id) > 0),
  model_version      text NOT NULL CHECK (length(model_version) > 0),
  dims               integer NOT NULL CHECK (dims >= 1),
  vector             vector NOT NULL,
  built_at           timestamptz NOT NULL DEFAULT now(),
  source_hash        sha256_hex NOT NULL,
  CHECK (vector_dims(vector) = dims),
  UNIQUE NULLS NOT DISTINCT (item_id, chunk_id, embedding_model_id, model_version)
);
CREATE INDEX embeddings_model_idx ON embeddings (embedding_model_id, model_version);

-- Grants for the app role. Nothing for PUBLIC.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ranker_app;

-- Mutable records (status, summaries, commit step, edge reversal, stale
-- marking, tombstoning of originals). Deletion is not part of the model.
GRANT SELECT, INSERT, UPDATE ON corpora, originals, items, classifications, edges, ranked_views
  TO ranker_app;
GRANT SELECT, INSERT ON item_originals TO ranker_app;
-- Derived, disposable index: rebuildable, so freely replaced.
GRANT SELECT, INSERT, UPDATE, DELETE ON embeddings TO ranker_app;
-- Append-only: Score events and their retractions, Policy versions, view
-- entries, view action events, tombstone records.
GRANT SELECT, INSERT ON score_events, score_retractions, policies,
  ranked_view_entries, ranked_view_actions, tombstones TO ranker_app;
GRANT USAGE ON SEQUENCE ranked_view_actions_id_seq TO ranker_app;
GRANT SELECT ON score_events_with_retraction, schema_migrations TO ranker_app;

INSERT INTO schema_migrations (version, name) VALUES (1, 'corpus_model');
