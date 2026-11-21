import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadContracts } from "../contracts/index.ts";
import { pgClient, type Db } from "../db/client.ts";
import { checkScore, type Policy } from "../kernel/index.ts";
import { s3ObjectStore, type ObjectStore } from "../storage/object-store.ts";
import { verifyExport, WEEKLY_FILES } from "./corpus-import-job.ts";
import { CorpusStore, importPapersJsonl, sha256, shortId, splitLines } from "./jsonl-importer.ts";
import { paperRubricV1 } from "./paper-rubric.ts";
import { readDimensionScores, readScoredAt, readScorer } from "./score-import.ts";

const corpusId = "cr_corpus_papers";
const importer = "agent:juno-historical-import";
export const DAILY_FILE = "papers-daily.jsonl";
export const publishedPaperRubricV1 = paperRubricV1({
  corpusId,
  createdAt: "2026-10-05T00:00:00Z",
  createdBy: importer,
  allowedScorers: [
    { kind: "human", identity: "joe" },
    { kind: "llm_judge", identity: "program:paper-judge" },
    // This is a provenance marker, not a claim about who assigned a score.
    { kind: "program", identity: "unknown" },
    // The corpus import Job's declared scorer (deploy/import/job.yaml,
    // RANKER_IMPORT_DECLARED_SCORER) for records that name none (CRANK-238).
    { kind: "program", identity: "juno:weekly-aggregation-triage" },
  ],
});
const policy = publishedPaperRubricV1;

export function readHistoricalExport(dir: string, files = WEEKLY_FILES, daily = false) {
  verifyExport(dir, files);
  const corpus = new CorpusStore();
  const rawByHash = new Map<string, Buffer>();
  const registry = loadContracts().registry;
  let records = 0;
  for (const file of files) {
    const bytes = readFileSync(join(dir, file));
    const report = importPapersJsonl(bytes, corpus, {
      corpusId, source: file, importedBy: daily ? "agent:research-aggregation" : importer, now: new Date().toISOString(), storageUriPrefix: "staged:", preservePublicationTransitions: daily,
    });
    if (report.errors.length) throw new Error(`${file}: ${report.errors.length} invalid paper record(s)`);
    records += report.records;
    for (const line of splitLines(bytes)) {
      if (line.toString("utf8").trim()) rawByHash.set(sha256(line), line);
    }
  }
  const events = corpus.items().flatMap((item) => item.original_ids.map((id) => {
    const record = corpus.original(id)!.raw_metadata;
    const dimensions = readDimensionScores(
      record, {}, [{ id }], daily ? "Hermes daily research score" : "Juno historical score",
    );
    if (typeof dimensions === "string" || dimensions.length !== 2) {
      throw new Error("Paper record must have both numeric paper-rubric dimensions");
    }
    const suppliedScorer = readScorer(record);
    const suppliedDate = readScoredAt(record);
    const dateKnown = typeof suppliedDate === "string";
    if (daily && (typeof suppliedScorer === "string" || suppliedScorer.identity !== "program:paper-judge" ||
        !suppliedScorer.model || !dateKnown || Date.parse(suppliedDate) > Date.now())) {
      throw new Error("Daily scores require the paper judge identity, model and a valid scoring timestamp");
    }
    const scorer = typeof suppliedScorer === "string" ? { identity: "unknown" } : suppliedScorer;
    // Juno confirmed first_seen is the scoring run's admission date. Use it
    // for ordering only and disclose that the actual scoring time is unknown.
    const orderingDate = dateKnown ? suppliedDate : readScoredAt({ scored_at: record.first_seen });
    if (typeof orderingDate !== "string") throw new Error("Historical score has no valid admission date");
    const source = {
      ...scorer,
      config: {
        ...scorer.config,
        scorer_provenance: typeof suppliedScorer === "string" ? "unknown" : "recorded",
        scored_at_provenance: dateKnown ? "recorded" : "unknown",
        scored_at_basis: dateKnown ? "recorded_timestamp" : "first_seen_date_ordering_only",
      },
    };
    const score = checkScore(policy, {
      item_id: item.id, policy_id: policy.id, policy_version: policy.version, dimension_scores: dimensions,
      scorer: source, source_blind: false,
    }, registry);
    return { ...score, id: shortId("cr_score_", policy.id, id), scored_at: orderingDate };
  }));
  return { records, corpus, events, rawByHash };
}

export interface PolicyCheck {
  policy_id: string;
  policy_version: number;
  status: "absent" | "matching" | "differing";
  differing_fields?: string[];
  missing_allowed_scorers?: Policy["judge_config"]["allowed_scorers"];
}

/**
 * Compare the stored paper-rubric v1 with the importer's publishedPaperRubricV1
 * in a read-only transaction, using the same fields importHistoricalExport
 * requires to match. Writes nothing to the database or the object store.
 */
export async function checkPaperPolicy(db: Db): Promise<PolicyCheck> {
  const head = { policy_id: policy.id, policy_version: policy.version };
  return db.transaction(async (tx) => {
    await tx.query("set transaction read only");
    const [row] = await tx.query<{ corpus_id: boolean; dimensions: boolean; judge_config: boolean; composite_rule: boolean; missing: Policy["judge_config"]["allowed_scorers"] }>(
      `select corpus_id = $3 as corpus_id, dimensions = $4::jsonb as dimensions,
        judge_config = $5::jsonb as judge_config, composite_rule = $6::jsonb as composite_rule,
        (select coalesce(jsonb_agg(want order by ord), '[]'::jsonb)
           from jsonb_array_elements($7::jsonb) with ordinality as w(want, ord)
          where not exists (select 1 from jsonb_array_elements(
            case when jsonb_typeof(judge_config->'allowed_scorers') = 'array' then judge_config->'allowed_scorers' else '[]'::jsonb end
          ) as have where have = want)) as missing
        from policies where id = $1 and version = $2`,
      [policy.id, policy.version, corpusId, JSON.stringify(policy.dimensions), JSON.stringify(policy.judge_config),
        JSON.stringify(policy.composite_rule), JSON.stringify(policy.judge_config.allowed_scorers)],
    );
    if (!row) return { ...head, status: "absent" };
    const differing = (["corpus_id", "dimensions", "judge_config", "composite_rule"] as const).filter((f) => !row[f]);
    if (!differing.length) return { ...head, status: "matching" };
    return { ...head, status: "differing", differing_fields: differing, missing_allowed_scorers: row.missing };
  });
}

export async function importHistoricalExport(dir: string, db: Db, store: ObjectStore, daily = false) {
  const files = daily ? [DAILY_FILE] : WEEKLY_FILES;
  const { records, corpus, events, rawByHash } = readHistoricalExport(dir, files, daily);
  const originals = corpus.originals();
  const items = corpus.items();
  // Content-addressed objects can be uploaded again after an interrupted run.
  // The source evidence is durable before the database transaction publishes it.
  for (let i = 0; i < originals.length; i += 16) {
    await Promise.all(originals.slice(i, i + 16).map((o) => store.put(o.content_hash, rawByHash.get(o.content_hash)!, o.media_type)));
  }
  await db.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext($1))", [corpusId]);
    await tx.query(`insert into corpora (id,name,description,taxonomy_id,status)
      values ($1,'papers','Applied AI research papers','cr_tax_papers','active') on conflict (id) do nothing`, [corpusId]);
    await tx.query(`insert into policies (id,version,name,corpus_id,dimensions,judge_config,composite_rule,created_by,created_at)
      values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,$8,$9) on conflict (id,version) do nothing`, [
      policy.id, policy.version, policy.name, corpusId, JSON.stringify(policy.dimensions),
      JSON.stringify(policy.judge_config), JSON.stringify(policy.composite_rule), policy.created_by, policy.created_at,
    ]);
    const [published] = await tx.query<{ matches: boolean }>(`select dimensions = $3::jsonb and judge_config = $4::jsonb
      and composite_rule = $5::jsonb and corpus_id = $6 as matches from policies where id=$1 and version=$2`, [
      policy.id, policy.version, JSON.stringify(policy.dimensions), JSON.stringify(policy.judge_config),
      JSON.stringify(policy.composite_rule), corpusId,
    ]);
    if (!published?.matches) throw new Error("Existing paper policy differs from the import policy");

    for (const o of originals) {
      await tx.query(`insert into originals (id,corpus_id,content_hash,media_type,byte_size,storage_uri,source,raw_metadata)
        values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb) on conflict (id) do nothing`, [
        o.id, corpusId, o.content_hash, o.media_type, o.byte_size, store.uri(o.content_hash),
        JSON.stringify(o.source), JSON.stringify(o.raw_metadata),
      ]);
    }
    for (const i of items) {
      await tx.query(`insert into items (id,corpus_id,item_type,title,summary,canonical_fields,identity_keys)
        values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) on conflict (id) do nothing`, [
        i.id, corpusId, i.item_type, i.title, i.summary, JSON.stringify(i.canonical_fields), JSON.stringify(i.identity_keys),
      ]);
      for (const id of i.original_ids) {
        await tx.query("insert into item_originals (item_id,original_id) values ($1,$2) on conflict do nothing", [i.id, id]);
      }
    }
    for (const item of items) {
      if (item.identity_keys.publication_version === undefined) continue;
      const parent = shortId("cr_item_", corpusId, item.identity_keys.arxiv_id!);
      const [preprint] = await tx.query<{ id: string }>("select id from items where id=$1 and corpus_id=$2", [parent, corpusId]);
      if (!preprint) throw new Error("Publication transition has no preprint item");
      await tx.query(`insert into edges (id,from_id,to_id,edge_type,created_by,evidence)
        values ($1,$2,$3,'supersedes',$4,$5::jsonb) on conflict (id) do nothing`, [
        shortId("cr_edge_", item.id, parent, "supersedes"), item.id, parent, "agent:research-aggregation",
        JSON.stringify({ original_ids: item.original_ids, source_version: item.canonical_fields.supersedes }),
      ]);
    }
    for (const score of events) {
      await tx.query(`insert into score_events
        (id,item_id,policy_id,policy_version,dimension_scores,scorer,scored_at,source_blind,recorded_at)
        values ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,clock_timestamp()) on conflict (id) do nothing`, [
        score.id, score.item_id, policy.id, policy.version, JSON.stringify(score.dimension_scores),
        JSON.stringify(score.scorer), score.scored_at, "false",
      ]);
    }
  });
  return { records, originals: originals.length, items: items.length, scores: events.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  function required(key: string): string {
    const value = process.env[key];
    if (!value) throw new Error(`${key} is required`);
    return value;
  }
  if (process.argv.includes("--check-policy")) {
    // Needs only the database: reads the stored policy, writes nothing.
    const db = pgClient(required("RANKER_DATABASE_URL"));
    try {
      const report = await checkPaperPolicy(db);
      console.log(JSON.stringify(report));
      process.exitCode = report.status === "differing" ? 1 : 0;
    } catch (error) {
      console.error(`Policy check failed: ${error instanceof Error ? error.name : "unknown error"}`);
      process.exitCode = 2;
    } finally {
      await db.end();
    }
  } else {
    const dir = required("RANKER_IMPORT_DIR");
    const daily = process.argv.includes("--daily");
    if (process.argv.includes("--check")) {
      const { records, corpus, events } = readHistoricalExport(dir, daily ? [DAILY_FILE] : WEEKLY_FILES, daily);
      console.log(JSON.stringify({ records, items: corpus.items().length, scores: events.length }));
    } else {
      const db = pgClient(required("RANKER_DATABASE_URL"));
      try {
        const store = s3ObjectStore({
          endpoint: required("RANKER_S3_ENDPOINT"), bucket: required("RANKER_S3_BUCKET"),
          accessKeyId: required("RANKER_S3_ACCESS_KEY_ID"), secretAccessKey: required("RANKER_S3_SECRET_ACCESS_KEY"),
        });
        console.log(JSON.stringify(await importHistoricalExport(dir, db, store, daily)));
      } catch (error) {
        console.error(`Historical import failed: ${error instanceof Error ? error.name : "unknown error"}`);
        process.exitCode = 1;
      } finally {
        await db.end();
      }
    }
  }
}
