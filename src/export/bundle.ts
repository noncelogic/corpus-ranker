// SPEC A5 export bundle, v1: a directory holding
//   manifest.json   bundle version, export time, schema version, counts, file hashes
//   database.sql    plain pg_dump of the ranker database (schema, grants, data)
//   *.jsonl         one contract-shaped (A2) object per line, IDs preserved:
//                   corpora, originals (the Originals manifest: hash, size,
//                   storage URI, provenance), items, classifications, edges,
//                   policies, scores, views, tombstones
// Embeddings are derived and left out (rebuild after restore). Original bytes
// stay in the object store, named by content hash; originals.jsonl is the
// manifest that ties each one to its hash and provenance.
//
// restoreBundle loads database.sql into an empty database (a fresh instance)
// after checking every file against the manifest, then re-derives the JSONL
// from the restored database and requires it to match the manifest, so a
// successful restore is proof the corpus came back whole.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BUNDLE_VERSION = 1;

/** The two capabilities export/restore need from a Postgres database. */
export interface PgSession {
  /** Run SQL (psql semantics, stop on first error); returns tuples-only, unaligned output. */
  query(sql: string): string;
  /** Run pg_dump with the given arguments; returns the plain-SQL dump. */
  dump(args: readonly string[]): string;
}

export interface BundleFile {
  sha256: string;
  bytes: number;
}

export interface BundleManifest {
  bundle_version: number;
  exported_at: string;
  /** Highest applied migration in the exported database. */
  schema_version: number;
  /** Records per JSONL file, keyed by file name without extension. */
  counts: Record<string, number>;
  files: Record<string, BundleFile>;
  embeddings: "excluded";
}

export interface ExportOptions {
  now?: () => Date;
}

export const DATABASE_FILE = "database.sql";
export const MANIFEST_FILE = "manifest.json";

// Owner-independent dump; embedding rows are derived and not carried (SPEC A5).
const DUMP_ARGS = ["--format=plain", "--no-owner", "--exclude-table-data=embeddings"] as const;

/** ISO-8601 UTC rendering of a timestamptz column (null stays null). */
const ts = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

// One query per JSONL file; each yields one compact JSON object per row, in a
// stable order, shaped as the v1 contract object.
const JSONL_QUERIES: Readonly<Record<string, string>> = {
  corpora: `
    select json_build_object('id', c.id, 'name', c.name, 'description', c.description,
      'taxonomy_id', c.taxonomy_id, 'created_at', ${ts("c.created_at")}, 'status', c.status)
    from corpora c order by c.id`,
  originals: `
    select json_build_object('id', o.id, 'corpus_id', o.corpus_id, 'content_hash', o.content_hash,
      'media_type', o.media_type, 'byte_size', o.byte_size, 'storage_uri', o.storage_uri,
      'source', o.source, 'raw_metadata', o.raw_metadata,
      'tombstoned_at', ${ts("o.tombstoned_at")}, 'tombstone_reason', o.tombstone_reason)
    from originals o order by o.id`,
  items: `
    select json_build_object('id', i.id, 'corpus_id', i.corpus_id, 'item_type', i.item_type,
      'title', i.title, 'summary', i.summary, 'canonical_fields', i.canonical_fields,
      'original_ids', coalesce((select json_agg(io.original_id order by io.original_id)
                                  from item_originals io where io.item_id = i.id), '[]'::json),
      'identity_keys', i.identity_keys, 'status', i.status,
      'created_at', ${ts("i.created_at")}, 'updated_at', ${ts("i.updated_at")})
    from items i order by i.id`,
  classifications: `
    select json_build_object('id', c.id, 'item_id', c.item_id, 'taxonomy_version', c.taxonomy_version,
      'labels', to_json(c.labels), 'status', c.status, 'proposed_by', c.proposed_by,
      'committed_by', c.committed_by, 'committed_at', ${ts("c.committed_at")},
      'confidence', c.confidence, 'rationale', c.rationale)
    from classifications c order by c.id`,
  edges: `
    select json_build_object('id', e.id, 'from_id', e.from_id,
      'to_id', case when e.to_system = 'corpus-ranker' then to_json(e.to_id)
                    else json_build_object('system', e.to_system, 'id', e.to_id) end,
      'edge_type', e.edge_type, 'created_by', e.created_by, 'created_at', ${ts("e.created_at")},
      'evidence', e.evidence, 'reversed_at', ${ts("e.reversed_at")}, 'reversed_by', e.reversed_by)
    from edges e order by e.id`,
  policies: `
    select json_build_object('id', p.id, 'name', p.name, 'corpus_id', p.corpus_id, 'version', p.version,
      'dimensions', p.dimensions, 'judge_config', p.judge_config, 'composite_rule', p.composite_rule,
      'created_by', p.created_by, 'created_at', ${ts("p.created_at")},
      'supersedes_version', p.supersedes_version)
    from policies p order by p.id, p.version`,
  scores: `
    select json_build_object('id', s.id, 'item_id', s.item_id, 'policy_id', s.policy_id,
      'policy_version', s.policy_version, 'dimension_scores', s.dimension_scores, 'scorer', s.scorer,
      'scored_at', ${ts("s.scored_at")}, 'source_blind', s.source_blind,
      'retracted_at', ${ts("s.retracted_at")}, 'retracted_by', s.retracted_by,
      'retraction_reason', s.retraction_reason)
    from score_events_with_retraction s order by s.id`,
  views: `
    select json_build_object('id', v.id, 'name', v.name, 'corpus_id', v.corpus_id,
      'policy_id', v.policy_id, 'policy_version', v.policy_version, 'query', v.query,
      'entries', coalesce((select json_agg(json_build_object('item_id', e.item_id, 'rank', e.rank,
                             'composite', e.composite, 'score_event_ids', to_json(e.score_event_ids))
                           order by e.rank)
                           from ranked_view_entries e where e.view_id = v.id), '[]'::json),
      'computed_at', ${ts("v.computed_at")}, 'stale', v.stale, 'stale_reason', v.stale_reason,
      'action_events', coalesce((select json_agg(json_build_object('item_id', a.item_id,
                                   'action_type', a.action_type, 'actor', a.actor, 'at', ${ts("a.at")})
                                 order by a.id)
                                 from ranked_view_actions a where a.view_id = v.id), '[]'::json))
    from ranked_views v order by v.id`,
  tombstones: `
    select json_build_object('id', t.id, 'target_id', t.target_id, 'reason', t.reason, 'actor', t.actor,
      'tombstoned_at', ${ts("t.tombstoned_at")}, 'preserved', t.preserved,
      'tombstoned_item_ids', to_json(t.tombstoned_item_ids), 'stale_view_ids', to_json(t.stale_view_ids))
    from tombstones t order by t.id`,
};

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const fileMeta = (b: Buffer): BundleFile => ({ sha256: sha256(b), bytes: b.length });

/** Derive every JSONL file from the database, read in one repeatable-read snapshot. */
function extractJsonl(db: PgSession): { files: Map<string, Buffer>; counts: Record<string, number> } {
  // Each query's rows are framed by a marker line so all files come from one
  // snapshot while staying separable. JSON text never contains a raw newline.
  const names = Object.keys(JSONL_QUERIES);
  const marker = (name: string) => `--cr-export:${name}--`;
  const sql = [
    "begin transaction isolation level repeatable read read only;",
    ...names.flatMap((n) => [`select '${marker(n)}';`, `${JSONL_QUERIES[n]!.trim()};`]),
    "commit;",
  ].join("\n");
  const lines = db.query(sql).split("\n");
  const files = new Map<string, Buffer>();
  const counts: Record<string, number> = {};
  let current: string[] | undefined;
  const flush = (name: string | undefined) => {
    if (name === undefined || current === undefined) return;
    files.set(`${name}.jsonl`, Buffer.from(current.map((l) => `${l}\n`).join(""), "utf8"));
    counts[name] = current.length;
  };
  let name: string | undefined;
  for (const raw of lines) {
    const line = raw.trim();
    const next = names.find((n) => line === marker(n));
    if (next !== undefined) {
      flush(name);
      name = next;
      current = [];
    } else if (line !== "" && current !== undefined) {
      current.push(line);
    }
  }
  flush(name);
  for (const n of names) if (!files.has(`${n}.jsonl`)) throw new Error(`export: no output for ${n}`);
  return { files, counts };
}

/** Produce the A5 bundle for the whole database into outDir (created if needed). */
export function exportBundle(db: PgSession, outDir: string, options: ExportOptions = {}): BundleManifest {
  const now = options.now ?? (() => new Date());
  const exportedAt = now().toISOString();
  const schemaVersion = Number(db.query("select coalesce(max(version), 0) from schema_migrations"));
  const dump = Buffer.from(db.dump(DUMP_ARGS), "utf8");
  const { files, counts } = extractJsonl(db);
  files.set(DATABASE_FILE, dump);

  mkdirSync(outDir, { recursive: true });
  const meta: Record<string, BundleFile> = {};
  for (const [file, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    writeFileSync(join(outDir, file), bytes);
    meta[file] = fileMeta(bytes);
  }
  const manifest: BundleManifest = {
    bundle_version: BUNDLE_VERSION,
    exported_at: exportedAt,
    schema_version: schemaVersion,
    counts,
    files: meta,
    embeddings: "excluded",
  };
  writeFileSync(join(outDir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Read manifest.json and check every listed file's hash and size; throws on any mismatch. */
export function verifyBundle(dir: string): BundleManifest {
  const manifest = JSON.parse(readFileSync(join(dir, MANIFEST_FILE), "utf8")) as BundleManifest;
  if (manifest.bundle_version !== BUNDLE_VERSION) {
    throw new Error(`unsupported bundle version ${String(manifest.bundle_version)} (expected ${BUNDLE_VERSION})`);
  }
  const expected = [DATABASE_FILE, ...Object.keys(JSONL_QUERIES).map((n) => `${n}.jsonl`)];
  for (const file of expected) if (!manifest.files?.[file]) throw new Error(`${file}: missing from manifest`);
  const present = new Set(readdirSync(dir));
  for (const [file, want] of Object.entries(manifest.files)) {
    if (!present.has(file)) throw new Error(`${file}: missing from bundle`);
    const got = fileMeta(readFileSync(join(dir, file)));
    if (got.sha256 !== want.sha256 || got.bytes !== want.bytes) throw new Error(`${file}: sha256 mismatch`);
  }
  return manifest;
}

// pg_dump does not carry roles; the dump's grants name the app role, so it
// must exist (NOLOGIN, as the migrations create it) before the dump loads.
const RESTORE_PREAMBLE = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ranker_app') THEN
    CREATE ROLE ranker_app NOLOGIN;
  END IF;
END
$$;
`;

/**
 * Restore a bundle into an empty database (a fresh instance): verify the
 * files, load the dump in one transaction, then require the restored
 * database to re-derive exactly the bundle's JSONL.
 */
export function restoreBundle(db: PgSession, dir: string): BundleManifest {
  const manifest = verifyBundle(dir);
  const tables = Number(db.query("select count(*) from pg_tables where schemaname = 'public'"));
  if (tables !== 0) throw new Error(`restore target is not empty (${tables} tables in schema public)`);

  const dump = readFileSync(join(dir, DATABASE_FILE), "utf8");
  db.query(`${RESTORE_PREAMBLE}\nBEGIN;\n${dump}\nCOMMIT;\n`);

  const { files } = extractJsonl(db);
  for (const [file, bytes] of files) {
    if (sha256(bytes) !== manifest.files[file]!.sha256) {
      throw new Error(`${file}: restored database does not reproduce the bundle`);
    }
  }
  return manifest;
}

/** A PgSession over the psql and pg_dump command-line clients. */
export function cliSession(databaseUrl: string): PgSession {
  const run = (bin: string, args: readonly string[], input?: string) =>
    execFileSync(bin, args, { input, encoding: "utf8", maxBuffer: 1 << 30, stdio: ["pipe", "pipe", "pipe"] });
  return {
    query: (sql) => run("psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-", "-d", databaseUrl], sql).trim(),
    dump: (args) => run("pg_dump", [...args, "-d", databaseUrl]),
  };
}
