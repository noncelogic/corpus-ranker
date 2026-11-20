import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadContracts } from "../contracts/index.ts";
import { pgClient, type Db } from "../db/client.ts";
import { checkScore } from "../kernel/index.ts";
import { s3ObjectStore, type ObjectStore } from "../storage/object-store.ts";
import { verifyExport, WEEKLY_FILES } from "./corpus-import-job.ts";
import { CorpusStore, importPapersJsonl, sha256, shortId, splitLines } from "./jsonl-importer.ts";
import { paperRubricV1 } from "./paper-rubric.ts";
import { readDimensionScores, readScoredAt, readScorer } from "./score-import.ts";

const corpusId = "cr_corpus_papers";
const importer = "agent:juno-historical-import";
const policy = paperRubricV1({
  corpusId,
  createdAt: "2026-10-05T00:00:00Z",
  createdBy: importer,
  allowedScorers: [
    { kind: "human", identity: "joe" },
    { kind: "llm_judge", identity: "program:paper-judge" },
    // This is a provenance marker, not a claim about who assigned a score.
    { kind: "program", identity: "unknown" },
  ],
});

export function readHistoricalExport(dir: string, files = WEEKLY_FILES) {
  verifyExport(dir, files);
  const corpus = new CorpusStore();
  const rawByHash = new Map<string, Buffer>();
  const registry = loadContracts().registry;
  let records = 0;
  for (const file of files) {
    const bytes = readFileSync(join(dir, file));
    const report = importPapersJsonl(bytes, corpus, {
      corpusId, source: file, importedBy: importer, now: new Date().toISOString(), storageUriPrefix: "staged:",
    });
    if (report.errors.length) throw new Error(`${file}: ${report.errors.length} invalid paper record(s)`);
    records += report.records;
    for (const line of splitLines(bytes)) {
      if (line.toString("utf8").trim()) rawByHash.set(sha256(line), line);
    }
  }
  const events = corpus.items().flatMap((item) => item.original_ids.map((id) => {
    const record = corpus.original(id)!.raw_metadata;
    const dimensions = readDimensionScores(record, {}, [{ id }], "Juno historical score");
    if (typeof dimensions === "string" || dimensions.length !== 2) {
      throw new Error("Historical record must have both numeric paper-rubric dimensions");
    }
    const suppliedScorer = readScorer(record);
    const suppliedDate = readScoredAt(record);
    const dateKnown = typeof suppliedDate === "string";
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

export async function importHistoricalExport(dir: string, db: Db, store: ObjectStore) {
  const { records, corpus, events, rawByHash } = readHistoricalExport(dir);
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
  const dir = required("RANKER_IMPORT_DIR");
  if (process.argv.includes("--check")) {
    const { records, corpus, events } = readHistoricalExport(dir);
    console.log(JSON.stringify({ records, items: corpus.items().length, scores: events.length }));
  } else {
    const db = pgClient(required("RANKER_DATABASE_URL"));
    try {
      const store = s3ObjectStore({
        endpoint: required("RANKER_S3_ENDPOINT"), bucket: required("RANKER_S3_BUCKET"),
        accessKeyId: required("RANKER_S3_ACCESS_KEY_ID"), secretAccessKey: required("RANKER_S3_SECRET_ACCESS_KEY"),
      });
      console.log(JSON.stringify(await importHistoricalExport(dir, db, store)));
    } catch (error) {
      console.error(`Historical import failed: ${error instanceof Error ? error.name : "unknown error"}`);
      process.exitCode = 1;
    } finally {
      await db.end();
    }
  }
}
