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
// exportBundle reads everything from one snapshot: a held repeatable-read
// transaction exports its snapshot, pg_dump runs on that snapshot, and the
// JSONL is read inside the same transaction, so concurrent corpus writes
// cannot make the dump and the JSONL disagree.
//
// restoreBundle loads database.sql into an empty database (a fresh instance)
// after checking every file against the manifest. One transaction refuses a
// non-empty target before any write, loads the dump, checks the schema version
// and re-derives the JSONL from the restored database, and commits only if all
// match the manifest, so a successful restore is proof the corpus came back
// whole and a failed one leaves the target as found (empty) for a retry.
//
// All SQL runs through the in-process client (src/db/client.ts); no code path
// spawns psql (docs/decisions/0001-in-process-postgres-client.md). Only the
// dump itself is taken by pg_dump.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pgClient, type Db, type Queryable } from "../db/client.ts";

export const BUNDLE_VERSION = 1;

/** The capabilities export/restore need from a Postgres database. */
export interface PgSession {
  /** The database through the in-process client; each step runs in one of its transactions. */
  db: Pick<Db, "transaction">;
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
// Rows are written as INSERT statements rather than COPY ... FROM stdin, whose
// inline data only psql can feed, so the whole dump is plain SQL the
// in-process client can send.
const DUMP_ARGS = [
  "--format=plain", "--no-owner", "--exclude-table-data=embeddings", "--inserts", "--rows-per-insert=500",
] as const;

/** ISO-8601 UTC rendering of a timestamptz column (null stays null). */
const ts = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

// One query per JSONL file; each yields one compact JSON object per row, in a
// stable order, shaped as the v1 contract object.
const JSONL_QUERIES: Readonly<Record<string, string>> = {
  corpora: `
    select json_build_object('id', c.id, 'name', c.name, 'description', c.description,
      'taxonomy_id', c.taxonomy_id, 'created_at', ${ts("c.created_at")}, 'status', c.status)::text as line
    from corpora c order by c.id`,
  originals: `
    select json_build_object('id', o.id, 'corpus_id', o.corpus_id, 'content_hash', o.content_hash,
      'media_type', o.media_type, 'byte_size', o.byte_size, 'storage_uri', o.storage_uri,
      'source', o.source, 'raw_metadata', o.raw_metadata,
      'tombstoned_at', ${ts("o.tombstoned_at")}, 'tombstone_reason', o.tombstone_reason)::text as line
    from originals o order by o.id`,
  items: `
    select json_build_object('id', i.id, 'corpus_id', i.corpus_id, 'item_type', i.item_type,
      'title', i.title, 'summary', i.summary, 'canonical_fields', i.canonical_fields,
      'original_ids', coalesce((select json_agg(io.original_id order by io.original_id)
                                  from item_originals io where io.item_id = i.id), '[]'::json),
      'identity_keys', i.identity_keys, 'status', i.status,
      'created_at', ${ts("i.created_at")}, 'updated_at', ${ts("i.updated_at")})::text as line
    from items i order by i.id`,
  classifications: `
    select json_build_object('id', c.id, 'item_id', c.item_id, 'taxonomy_version', c.taxonomy_version,
      'labels', to_json(c.labels), 'status', c.status, 'proposed_by', c.proposed_by,
      'committed_by', c.committed_by, 'committed_at', ${ts("c.committed_at")},
      'confidence', c.confidence, 'rationale', c.rationale)::text as line
    from classifications c order by c.id`,
  edges: `
    select json_build_object('id', e.id, 'from_id', e.from_id,
      'to_id', case when e.to_system = 'corpus-ranker' then to_json(e.to_id)
                    else json_build_object('system', e.to_system, 'id', e.to_id) end,
      'edge_type', e.edge_type, 'created_by', e.created_by, 'created_at', ${ts("e.created_at")},
      'evidence', e.evidence, 'reversed_at', ${ts("e.reversed_at")}, 'reversed_by', e.reversed_by)::text as line
    from edges e order by e.id`,
  policies: `
    select json_build_object('id', p.id, 'name', p.name, 'corpus_id', p.corpus_id, 'version', p.version,
      'dimensions', p.dimensions, 'judge_config', p.judge_config, 'composite_rule', p.composite_rule,
      'created_by', p.created_by, 'created_at', ${ts("p.created_at")},
      'supersedes_version', p.supersedes_version)::text as line
    from policies p order by p.id, p.version`,
  scores: `
    select json_build_object('id', s.id, 'item_id', s.item_id, 'policy_id', s.policy_id,
      'policy_version', s.policy_version, 'dimension_scores', s.dimension_scores, 'scorer', s.scorer,
      'scored_at', ${ts("s.scored_at")}, 'source_blind', s.source_blind,
      'retracted_at', ${ts("s.retracted_at")}, 'retracted_by', s.retracted_by,
      'retraction_reason', s.retraction_reason)::text as line
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
                                 from ranked_view_actions a where a.view_id = v.id), '[]'::json))::text as line
    from ranked_views v order by v.id`,
  tombstones: `
    select json_build_object('id', t.id, 'target_id', t.target_id, 'reason', t.reason, 'actor', t.actor,
      'tombstoned_at', ${ts("t.tombstoned_at")}, 'preserved', t.preserved,
      'tombstoned_item_ids', to_json(t.tombstoned_item_ids), 'stale_view_ids', to_json(t.stale_view_ids))::text as line
    from tombstones t order by t.id`,
};

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const fileMeta = (b: Buffer): BundleFile => ({ sha256: sha256(b), bytes: b.length });

/** Derive every JSONL file; run it inside a transaction so all files share one snapshot. */
async function readJsonl(tx: Queryable): Promise<{ files: Map<string, Buffer>; counts: Record<string, number> }> {
  const files = new Map<string, Buffer>();
  const counts: Record<string, number> = {};
  for (const [name, sql] of Object.entries(JSONL_QUERIES)) {
    // Each row is the JSON object's text as Postgres renders it, one per line.
    const rows = await tx.query<{ line: string }>(sql);
    files.set(`${name}.jsonl`, Buffer.from(rows.map((r) => `${r.line}\n`).join(""), "utf8"));
    counts[name] = rows.length;
  }
  return { files, counts };
}

const schemaVersionOf = async (tx: Queryable): Promise<number> =>
  (await tx.query<{ v: number }>("select coalesce(max(version), 0)::int as v from schema_migrations"))[0]!.v;

/** Produce the A5 bundle for the whole database into outDir (created if needed). */
export async function exportBundle(db: PgSession, outDir: string, options: ExportOptions = {}): Promise<BundleManifest> {
  const now = options.now ?? (() => new Date());
  const exportedAt = now().toISOString();

  // Hold one read-only repeatable-read transaction for the whole export: its
  // exported snapshot is what pg_dump reads, and the JSONL and schema version
  // are read inside it, so every file reflects the same database state.
  const { dump, schemaVersion, extracted } = await db.db.transaction(async (tx) => {
    await tx.query("set transaction isolation level repeatable read read only");
    const [row] = await tx.query<{ snapshot: string }>("select pg_export_snapshot() as snapshot");
    const snapshot = row!.snapshot;
    if (!/^[0-9A-Fa-f-]+$/.test(snapshot)) throw new Error(`export: unexpected snapshot id ${JSON.stringify(snapshot)}`);
    return {
      dump: Buffer.from(db.dump([...DUMP_ARGS, `--snapshot=${snapshot}`]), "utf8"),
      schemaVersion: await schemaVersionOf(tx),
      extracted: await readJsonl(tx),
    };
  });
  const { files, counts } = extracted;
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

// Relations (tables, views, sequences, ...) outside the system schemas; an
// empty target has none, whatever extensions its instance pre-installs.
const TARGET_CHECK = `
select current_database() as target, count(*)::int as relations
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
   and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%'`;

/**
 * The dump as SQL the in-process client can send: pg_dump's \restrict and
 * \unrestrict lines are psql meta-commands guarding psql itself and are
 * dropped; COPY ... FROM stdin (inline data only psql can feed) is refused.
 */
function dumpSql(dump: string): string {
  if (/^COPY .* FROM stdin;$/m.test(dump)) {
    throw new Error(`${DATABASE_FILE}: COPY ... FROM stdin is not supported; the dump must be taken with --inserts`);
  }
  return dump.replace(/^\\(un)?restrict [A-Za-z0-9]+$/gm, "");
}

/**
 * Restore a bundle into an empty database (a fresh instance): verify the
 * files, then, in one transaction, refuse a target that already holds corpus
 * data before writing anything, load the dump, and require the restored data
 * to be at the manifest's schema version and to re-derive exactly the
 * bundle's JSONL; commit only then, so a failed restore leaves the target as
 * it was found (empty) and the same restore can run again.
 */
export async function restoreBundle(db: PgSession, dir: string): Promise<BundleManifest> {
  const manifest = verifyBundle(dir);
  const dump = dumpSql(readFileSync(join(dir, DATABASE_FILE), "utf8"));
  // Any throw below rolls the whole transaction back, preamble role included.
  await db.db.transaction(async (tx) => {
    const [{ target, relations } = { target: "", relations: -1 }] =
      await tx.query<{ target: string; relations: number }>(TARGET_CHECK);
    if (relations !== 0) {
      throw new Error(`restore target database "${target}" is not empty (${relations} relations); restore needs an empty database`);
    }
    await tx.query(RESTORE_PREAMBLE);
    await tx.query(dump);
    // The dump empties search_path for the session; restore it for the checks.
    await tx.query("reset search_path");
    const schemaVersion = await schemaVersionOf(tx);
    if (schemaVersion !== manifest.schema_version) {
      throw new Error(`restored schema version ${schemaVersion} does not match the manifest's ${String(manifest.schema_version)}`);
    }
    const { files } = await readJsonl(tx);
    for (const [file, bytes] of files) {
      if (sha256(bytes) !== manifest.files[file]!.sha256) {
        throw new Error(`${file}: restored database does not reproduce the bundle`);
      }
    }
  });
  return manifest;
}

/** A PgSession over the in-process client and the pg_dump command-line client; end() closes the pool. */
export function cliSession(databaseUrl: string): PgSession & { end(): Promise<void> } {
  const db = pgClient(databaseUrl);
  return {
    db,
    dump: (args) =>
      execFileSync("pg_dump", [...args, "-d", databaseUrl], {
        encoding: "utf8",
        maxBuffer: 1 << 30,
        stdio: ["pipe", "pipe", "pipe"],
      }),
    end: () => db.end(),
  };
}
