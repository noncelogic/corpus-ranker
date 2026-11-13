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
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BUNDLE_VERSION = 1;

/** The capabilities export/restore need from a Postgres database. */
export interface PgSession {
  /** Run SQL (psql semantics, stop on first error); returns tuples-only, unaligned output. */
  query(sql: string): string;
  /** Run pg_dump with the given arguments; returns the plain-SQL dump. */
  dump(args: readonly string[]): string;
  /**
   * Start one long-lived psql (same flags as query, reading SQL from stdin)
   * so a transaction can stay open across several steps.
   */
  open(): ChildProcessWithoutNullStreams;
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

const marker = (name: string) => `--cr-export:${name}--`;

/** SQL deriving every JSONL file; run it inside a transaction so all files share one snapshot. */
function jsonlSql(): string {
  // Each query's rows are framed by a marker line so the files stay
  // separable. JSON text never contains a raw newline.
  return Object.keys(JSONL_QUERIES)
    .flatMap((n) => [`select '${marker(n)}';`, `${JSONL_QUERIES[n]!.trim()};`])
    .join("\n");
}

/** Split the output of jsonlSql() into the JSONL files. */
function parseJsonl(output: string): { files: Map<string, Buffer>; counts: Record<string, number> } {
  const names = Object.keys(JSONL_QUERIES);
  const files = new Map<string, Buffer>();
  const counts: Record<string, number> = {};
  let current: string[] | undefined;
  const flush = (name: string | undefined) => {
    if (name === undefined || current === undefined) return;
    files.set(`${name}.jsonl`, Buffer.from(current.map((l) => `${l}\n`).join(""), "utf8"));
    counts[name] = current.length;
  };
  let name: string | undefined;
  for (const raw of output.split("\n")) {
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

/**
 * A psql process driven step by step over stdin, so one transaction can span
 * several steps. psql runs with ON_ERROR_STOP, so any SQL error ends the
 * process and the open transaction is rolled back by the server.
 */
class PsqlConversation {
  private out = "";
  private err = "";
  private exited: Promise<number | null>;
  private exitCode: number | null | undefined;
  private waiter: (() => void) | undefined;
  private seq = 0;
  private readonly child: ChildProcessWithoutNullStreams;

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      this.out += d;
      this.waiter?.();
    });
    child.stderr.on("data", (d: string) => {
      this.err += d;
    });
    child.stdin.on("error", () => {
      /* surfaced through the exit code */
    });
    this.exited = new Promise((ok) => {
      child.on("error", (e) => {
        this.err += String(e);
      });
      child.on("close", (code) => {
        this.exitCode = code;
        this.waiter?.();
        ok(code);
      });
    });
  }

  /** Send SQL and resolve with its output once psql has executed all of it. */
  run(sql: string): Promise<string> {
    const done = `--cr-step-${++this.seq}--`;
    this.child.stdin.write(`${sql}\n;\nselect '${done}';\n`);
    return new Promise((ok, fail) => {
      const check = () => {
        const at = this.out.indexOf(`${done}\n`);
        if (at >= 0) {
          const result = this.out.slice(0, at);
          this.out = this.out.slice(at + done.length + 1);
          this.waiter = undefined;
          ok(result);
        } else if (this.exitCode !== undefined) {
          this.waiter = undefined;
          fail(new Error(`psql exited (${String(this.exitCode)}): ${this.err.trim()}`));
        }
      };
      this.waiter = check;
      check();
    });
  }

  /** Send the final SQL, end the session and wait for psql to exit cleanly. */
  async close(sql: string): Promise<void> {
    this.child.stdin.end(`${sql}\n`);
    const code = await this.exited;
    if (code !== 0) throw new Error(`psql exited (${String(code)}): ${this.err.trim()}`);
  }

  /** Abandon the session; the server rolls back any open transaction. */
  kill(): void {
    if (this.exitCode === undefined) this.child.kill();
  }
}

/** Produce the A5 bundle for the whole database into outDir (created if needed). */
export async function exportBundle(db: PgSession, outDir: string, options: ExportOptions = {}): Promise<BundleManifest> {
  const now = options.now ?? (() => new Date());
  const exportedAt = now().toISOString();

  // Hold one read-only repeatable-read transaction for the whole export: its
  // exported snapshot is what pg_dump reads, and the JSONL and schema version
  // are read inside it, so every file reflects the same database state.
  const tx = new PsqlConversation(db.open());
  let schemaVersion: number;
  let dump: Buffer;
  let extracted: ReturnType<typeof parseJsonl>;
  try {
    const snapshot = (
      await tx.run("begin transaction isolation level repeatable read read only;\nselect pg_export_snapshot();")
    ).trim();
    if (!/^[0-9A-Fa-f-]+$/.test(snapshot)) throw new Error(`export: unexpected snapshot id ${JSON.stringify(snapshot)}`);
    dump = Buffer.from(db.dump([...DUMP_ARGS, `--snapshot=${snapshot}`]), "utf8");
    schemaVersion = Number((await tx.run("select coalesce(max(version), 0) from schema_migrations;")).trim());
    extracted = parseJsonl(await tx.run(jsonlSql()));
    await tx.close("commit;");
  } finally {
    tx.kill();
  }
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
select current_database() || '|' || count(*)
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
   and n.nspname not in ('pg_catalog', 'information_schema') and n.nspname not like 'pg_toast%';`;

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
  const dump = readFileSync(join(dir, DATABASE_FILE), "utf8");
  const tx = new PsqlConversation(db.open());
  // Any throw below ends the session without COMMIT (kill in finally), so the
  // server rolls the whole transaction back, preamble role included.
  const fail = async (message: string): Promise<never> => {
    await tx.close("ROLLBACK;");
    throw new Error(message);
  };
  try {
    const [target, relations] = (await tx.run(`BEGIN;\n${TARGET_CHECK}`)).trim().split("|");
    if (Number(relations) !== 0) {
      await fail(`restore target database "${target}" is not empty (${relations} relations); restore needs an empty database`);
    }
    await tx.run(RESTORE_PREAMBLE);
    // The dump empties search_path for the session; restore it for the checks.
    await tx.run(`${dump}\n;\nRESET search_path;`);
    const schemaVersion = Number((await tx.run("select coalesce(max(version), 0) from schema_migrations;")).trim());
    if (schemaVersion !== manifest.schema_version) {
      await fail(`restored schema version ${schemaVersion} does not match the manifest's ${String(manifest.schema_version)}`);
    }
    const { files } = parseJsonl(await tx.run(jsonlSql()));
    for (const [file, bytes] of files) {
      if (sha256(bytes) !== manifest.files[file]!.sha256) {
        await fail(`${file}: restored database does not reproduce the bundle`);
      }
    }
    await tx.close("COMMIT;");
  } finally {
    tx.kill();
  }
  return manifest;
}

/** A PgSession over the psql and pg_dump command-line clients. */
export function cliSession(databaseUrl: string): PgSession {
  const run = (bin: string, args: readonly string[], input?: string) =>
    execFileSync(bin, args, { input, encoding: "utf8", maxBuffer: 1 << 30, stdio: ["pipe", "pipe", "pipe"] });
  const psqlArgs = ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-", "-d", databaseUrl];
  return {
    query: (sql) => run("psql", psqlArgs, sql).trim(),
    dump: (args) => run("pg_dump", [...args, "-d", databaseUrl]),
    open: () => spawn("psql", psqlArgs, { stdio: ["pipe", "pipe", "pipe"] }),
  };
}
