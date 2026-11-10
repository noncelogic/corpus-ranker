// Historical score importer (SPEC §A7 Phase 0).
//
// Reads the same weekly papers JSONL as the Item/Original importer and turns
// each record's existing Relevance / Technical Merit scores into a Score event
// under Policy paper-rubric v1, keeping who scored it and when. The papers
// must already be imported (importPapersJsonl): a score is recorded against
// the record's Item, with the record's Original as its evidence.
//
// Record fields read:
//   scores     { relevance, technical_merit } (or the dimension names themselves)
//   reasons    optional, same keys; a missing reason is stated as missing, never invented
//   scorer     identity string, or { identity, model?, config? }
//   model      optional, the judge model when `scorer` is a string
//   scored_at  ISO 8601 timestamp, or a YYYY-MM-DD date (taken as 00:00 UTC)
// A record with no `scores` is simply unscored. Scores missing a scorer or
// date are reported, not filled in from the import.
import { KernelError, type DimensionScore, type RankerKernel, type Scorer } from "../kernel/index.ts";
import { CorpusStore, isObject, recordArxivId, sha256, shortId, splitLines, type ImportError } from "./jsonl-importer.ts";
import { PAPER_RUBRIC_ID } from "./paper-rubric.ts";

export interface ScoreImportOptions {
  corpusId: string;
  /** Name of the file being imported, quoted in reasons the file did not record. */
  source: string;
  policyId?: string;
  policyVersion?: number;
}

export interface ScoreImportReport {
  /** Non-blank lines read. */
  records: number;
  scoresImported: number;
  /** Records carrying no scores. */
  unscoredRecords: number;
  /** Records whose Score event was recorded by an earlier import. */
  alreadyImported: number;
  errors: ImportError[];
}

/** File keys for each paper-rubric v1 dimension. */
export const DIMENSION_KEYS: [dimension: string, keys: string[]][] = [
  ["Relevance", ["relevance", "Relevance"]],
  ["Technical Merit", ["technical_merit", "technicalMerit", "Technical Merit"]],
];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (obj[k] !== undefined) return obj[k];
  return undefined;
}

function readScorer(rec: Record<string, unknown>): Scorer | string {
  const raw = rec.scorer ?? rec.scored_by;
  let scorer: Scorer;
  if (typeof raw === "string" && raw.trim() !== "") scorer = { identity: raw.trim() };
  else if (isObject(raw) && typeof raw.identity === "string") {
    scorer = { identity: raw.identity };
    if (typeof raw.model === "string") scorer.model = raw.model;
    if (isObject(raw.config)) scorer.config = raw.config;
  } else return "scores have no scorer";
  if (scorer.model === undefined && typeof rec.model === "string" && rec.model !== "") scorer.model = rec.model;
  return scorer;
}

function readScoredAt(rec: Record<string, unknown>): string | { error: string } {
  const raw = rec.scored_at;
  if (typeof raw !== "string" || raw.trim() === "") return { error: "scores have no scored_at date" };
  const s = raw.trim();
  const ts = DATE_ONLY.test(s) ? `${s}T00:00:00Z` : s;
  if (!DATE_TIME.test(ts) || Number.isNaN(Date.parse(ts))) return { error: `scored_at ${JSON.stringify(raw)} is not a date` };
  return ts;
}

/**
 * Import the historical scores in one weekly papers JSONL file as Score events
 * in `kernel`. Bad records are reported and skipped. Re-importing a file is a
 * no-op: each Score's id is derived from the corpus, policy version and the
 * record's capture hash.
 */
export function importScoresJsonl(
  data: Uint8Array | string,
  store: CorpusStore,
  kernel: RankerKernel,
  opts: ScoreImportOptions,
): ScoreImportReport {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const policyId = opts.policyId ?? PAPER_RUBRIC_ID;
  const policyVersion = opts.policyVersion ?? 1;
  const report: ScoreImportReport = { records: 0, scoresImported: 0, unscoredRecords: 0, alreadyImported: 0, errors: [] };

  splitLines(bytes).forEach((line, index) => {
    const lineNo = index + 1;
    const fail = (message: string) => report.errors.push({ line: lineNo, message });
    const text = line.toString("utf8");
    if (text.trim() === "") return;
    report.records++;

    let rec: unknown;
    try {
      rec = JSON.parse(text);
    } catch (e) {
      return fail(`invalid JSON: ${(e as Error).message}`);
    }
    if (!isObject(rec)) return fail("record is not a JSON object");
    if (rec.scores === undefined || rec.scores === null) {
      report.unscoredRecords++;
      return;
    }
    if (!isObject(rec.scores)) return fail("scores is not an object");
    const scores = rec.scores;
    const reasons = isObject(rec.reasons) ? rec.reasons : {};

    const scorer = readScorer(rec);
    if (typeof scorer === "string") return fail(scorer);
    const scoredAt = readScoredAt(rec);
    if (typeof scoredAt !== "string") return fail(scoredAt.error);

    const arxivId = recordArxivId(rec);
    if (arxivId === undefined) return fail("record has no arXiv ID");
    const item = store.itemByArxivId(arxivId, opts.corpusId);
    if (item === undefined) return fail(`no Item for arXiv ${arxivId}; import the papers first`);

    const captureHash = sha256(line);
    const original = store.originalByHash(opts.corpusId, captureHash);
    const evidence = original === undefined ? [] : [{ id: original.id }];

    const dimensionScores: DimensionScore[] = [];
    for (const [dimension, keys] of DIMENSION_KEYS) {
      const value = pick(scores, keys);
      if (value === undefined || value === null) continue;
      if (typeof value !== "number") return fail(`${dimension} score ${JSON.stringify(value)} is not a number`);
      const reason = pick(reasons, keys);
      dimensionScores.push({
        dimension,
        value,
        reason:
          typeof reason === "string" && reason.trim() !== ""
            ? reason
            : `Historical score imported from ${opts.source} line ${lineNo}; no reason recorded.`,
        evidence: structuredClone(evidence),
      });
    }
    if (dimensionScores.length === 0) return fail("scores name no paper-rubric dimension");

    const id = shortId("cr_score_", opts.corpusId, policyId, String(policyVersion), captureHash);
    if (kernel.getScore(id) !== undefined) {
      report.alreadyImported++;
      return;
    }
    try {
      kernel.importScore({
        id,
        item_id: item.id,
        policy_id: policyId,
        policy_version: policyVersion,
        dimension_scores: dimensionScores,
        scorer,
        source_blind: typeof rec.source_blind === "boolean" ? rec.source_blind : false,
        scored_at: scoredAt,
      });
    } catch (e) {
      if (e instanceof KernelError) return fail(e.message);
      throw e;
    }
    report.scoresImported++;
  });

  return report;
}
