// One-shot import of Juno's staged weekly papers into the deployed ranker
// (SPEC A7 Phase 0), run by the Job ranker-corpus-import (deploy/import/).
//
// Reads papers-2026-W41.jsonl through papers-2026-W47.jsonl from the export
// directory, after checking every one of them (and every other file listed)
// against SHA256SUMS there; a mismatch, or a weekly file the sums do not name,
// stops the import before anything is posted. Then, record by record in file
// order, it posts the record's exact bytes through capture
// (POST /v1/corpora/{corpus_id}/originals; content-addressed, so a re-run finds
// the same Originals) and, for a scored record, its paper-rubric v1 score
// through POST /v1/scores, keeping the scorer and the date the file records,
// with the captured Original as evidence. Juno's weekly records carry
// relevance / technical_merit as top-level numbers with no scorer or
// scored_at: those are scored with the Job's declared scorer
// (RANKER_IMPORT_DECLARED_SCORER, whose config states the provenance as
// reconstructed), scored_at from first_seen (the date of the aggregation run
// that scored them) and the record's verdict as the reason. Any scorer or
// scored_at a record names itself is kept unchanged. The Item a score cites is the one
// the JSONL importer derives for the record's arXiv ID.
//
// It logs counts only (records, originals created, duplicates, scores,
// unscored, failed) and, for a failure, the file, line and HTTP status: never
// a record's contents or a response body, since the export is private
// research data. Any failed post (or a scored record that cannot form a score)
// makes the process exit non-zero; failures are never counted as imported.
//
// Environment: RANKER_IMPORT_DIR (the export, /import in the Job),
// RANKER_API_URL (the ranker-api Service), RANKER_API_KEY (the ranker-api-keys
// Secret), RANKER_CORPUS_ID, RANKER_IMPORT_CAPTURED_BY (default agent:corpus-import),
// RANKER_IMPORT_DECLARED_SCORER (JSON scorer for records that name none).
// tests/deploy/corpus-import-job.test.ts holds all of this.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isObject, recordArxivId, shortId, splitLines } from "./jsonl-importer.ts";
import type { Scorer } from "../kernel/index.ts";
import { PAPER_RUBRIC_ID } from "./paper-rubric.ts";
import { readDimensionScores, readScoredAt, readScorer } from "./score-import.ts";

/** The staged weekly files, imported in this order. */
export const WEEKLY_FILES = ["W41", "W42", "W43", "W44", "W45", "W46", "W47"].map((w) => `papers-2026-${w}.jsonl`);

const REQUEST_TIMEOUT_MS = 60_000;

export interface CorpusImportOptions {
  dir: string;
  apiUrl: string;
  apiKey: string;
  corpusId: string;
  capturedBy: string;
  /**
   * The scorer for records that carry top-level scores but name none (Juno's
   * weekly shape), stated as reconstructed provenance in its config.
   */
  declaredScorer?: Scorer;
  files?: string[];
  fetch?: typeof fetch;
  /** One line of output (default: stdout). */
  log?: (line: string) => void;
}

export interface CorpusImportCounts {
  records: number;
  originals_created: number;
  duplicates: number;
  scores: number;
  unscored: number;
  failed: number;
}

export class ExportIntegrityError extends Error {
  override name = "ExportIntegrityError";
}

/**
 * Check every file SHA256SUMS in `dir` lists against its hash, and that each
 * of `required` is listed. Throws ExportIntegrityError naming the file.
 */
export function verifyExport(dir: string, required: string[]): void {
  let sums: string;
  try {
    sums = readFileSync(join(dir, "SHA256SUMS"), "utf8");
  } catch (e) {
    throw new ExportIntegrityError(`cannot read SHA256SUMS (${(e as NodeJS.ErrnoException).code ?? "error"})`);
  }
  const listed = new Map<string, string>();
  for (const [n, line] of sums.split("\n").entries()) {
    if (line.trim() === "") continue;
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line.replace(/\r$/, ""));
    if (!m) throw new ExportIntegrityError(`SHA256SUMS line ${n + 1} is not "<sha256>  <file>"`);
    listed.set(m[2]!, m[1]!.toLowerCase());
  }
  for (const file of required) {
    if (!listed.has(file)) throw new ExportIntegrityError(`SHA256SUMS does not list ${file}`);
  }
  for (const [file, want] of listed) {
    let got: string;
    try {
      got = createHash("sha256").update(readFileSync(join(dir, file))).digest("hex");
    } catch (e) {
      throw new ExportIntegrityError(`cannot read ${file} (${(e as NodeJS.ErrnoException).code ?? "error"})`);
    }
    if (got !== want) throw new ExportIntegrityError(`${file} does not match SHA256SUMS`);
  }
}

/** A record's score as the importer posts it; a message when it cannot form one. */
interface RecordScore {
  scores: Record<string, unknown>;
  reasons: Record<string, unknown>;
  scorer: Scorer;
  scoredAt: string;
}

/** Juno's weekly shape: top-level relevance / technical_merit and no `scores` object. */
function hasTopLevelScores(rec: Record<string, unknown>): boolean {
  return (rec.scores === undefined || rec.scores === null) &&
    (typeof rec.relevance === "number" || typeof rec.technical_merit === "number");
}

/**
 * The score a record carries: undefined when it is unscored. A record with a
 * `scores` object is read exactly as recorded (its own scorer and scored_at).
 * A Juno-shaped record (top-level numbers) keeps any scorer or scored_at it
 * names; otherwise its scorer is the Job's declared one and its scored_at its
 * first_seen date, with its verdict as the reason for both dimensions.
 */
function readRecordScore(rec: Record<string, unknown>, declared: Scorer | undefined): RecordScore | string | undefined {
  if (hasTopLevelScores(rec)) {
    const ownScorer = rec.scorer != null || rec.scored_by != null;
    const scorer = ownScorer ? readScorer(rec) : declared ?? "scores have no scorer and the Job declares none";
    if (typeof scorer === "string") return scorer;
    const scoredAt = rec.scored_at != null ? readScoredAt(rec) : readScoredAt({ scored_at: rec.first_seen });
    if (typeof scoredAt !== "string") return rec.scored_at != null ? scoredAt.error : "scores have no scored_at and no first_seen date";
    const verdict = typeof rec.verdict === "string" && rec.verdict.trim() !== "" ? rec.verdict : undefined;
    const reasons = verdict === undefined ? {} : { relevance: verdict, technical_merit: verdict };
    return { scores: rec, reasons, scorer, scoredAt };
  }
  if (rec.scores === undefined || rec.scores === null) return undefined;
  if (!isObject(rec.scores)) return "scores is not an object";
  const scorer = readScorer(rec);
  if (typeof scorer === "string") return scorer;
  const scoredAt = readScoredAt(rec);
  if (typeof scoredAt !== "string") return "scored_at is missing or not a date";
  return { scores: rec.scores, reasons: isObject(rec.reasons) ? rec.reasons : {}, scorer, scoredAt };
}

/**
 * Reject Juno-shaped records that cannot form a score (no scorer of their own
 * and none declared, or no scored_at and no first_seen) before any write, so
 * their scores are never silently dropped.
 */
function verifyScoreFormat(dir: string, files: string[], declared: Scorer | undefined): void {
  let legacyCount = 0;
  for (const file of files) {
    for (const line of splitLines(readFileSync(join(dir, file)))) {
      const text = line.toString("utf8").trim();
      if (!text) continue;
      let record: unknown;
      try {
        record = JSON.parse(text);
      } catch {
        continue; // Existing per-record import diagnostics handle malformed JSON.
      }
      if (isObject(record) && hasTopLevelScores(record) && typeof readRecordScore(record, declared) === "string") {
        legacyCount++;
      }
    }
  }
  if (legacyCount > 0) {
    throw new ExportIntegrityError(
      `${legacyCount} record(s) have legacy top-level paper scores with no scorer (recorded or declared for the Job) or no scored_at or first_seen date.`,
    );
  }
}

/**
 * The Job-level declared scorer from its JSON (RANKER_IMPORT_DECLARED_SCORER),
 * e.g. {"identity":"juno:weekly-aggregation-triage","config":{...}}.
 */
export function parseDeclaredScorer(json: string): Scorer {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ExportIntegrityError("RANKER_IMPORT_DECLARED_SCORER is not JSON");
  }
  const scorer = readScorer({ scorer: raw });
  if (typeof scorer === "string" || scorer.identity.trim() === "") {
    throw new ExportIntegrityError("RANKER_IMPORT_DECLARED_SCORER has no identity");
  }
  return scorer;
}

/** Import the export in `opts.dir`; resolves with the counts (failed > 0 means the import failed). */
export async function runCorpusImport(opts: CorpusImportOptions): Promise<CorpusImportCounts> {
  const files = opts.files ?? WEEKLY_FILES;
  const log = opts.log ?? ((line: string) => process.stdout.write(line + "\n"));
  const doFetch = opts.fetch ?? fetch;
  verifyExport(opts.dir, files);
  verifyScoreFormat(opts.dir, files, opts.declaredScorer);

  const base = opts.apiUrl.replace(/\/+$/, "");
  const captureUrl = `${base}/v1/corpora/${encodeURIComponent(opts.corpusId)}/originals`;
  const scoreUrl = `${base}/v1/scores`;
  const post = async (url: string, body: unknown): Promise<{ status: number; body: unknown }> => {
    try {
      const res = await doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        // A non-JSON answer is reported by its status alone.
      }
      return { status: res.status, body: parsed };
    } catch {
      return { status: 0, body: null }; // network error or timeout
    }
  };

  const total: CorpusImportCounts = { records: 0, originals_created: 0, duplicates: 0, scores: 0, unscored: 0, failed: 0 };
  for (const file of files) {
    const counts: CorpusImportCounts = { records: 0, originals_created: 0, duplicates: 0, scores: 0, unscored: 0, failed: 0 };
    // File, line and a reason or status only: never contents.
    const fail = (line: number, step: string, why: string) => {
      counts.failed++;
      log(JSON.stringify({ event: "failed", file, line, step, why }));
    };
    const lines = splitLines(readFileSync(join(opts.dir, file)));
    for (const [index, line] of lines.entries()) {
      const lineNo = index + 1;
      if (line.toString("utf8").trim() === "") continue;
      counts.records++;

      let rec: unknown;
      try {
        rec = JSON.parse(line.toString("utf8"));
      } catch {
        fail(lineNo, "parse", "invalid JSON");
        continue;
      }
      if (!isObject(rec)) {
        fail(lineNo, "parse", "record is not a JSON object");
        continue;
      }

      const captured = await post(captureUrl, {
        content_base64: line.toString("base64"),
        media_type: "application/json",
        source: { source_kind: "upload", source: file },
        captured_by: opts.capturedBy,
        raw_metadata: rec,
      });
      const originalId = isObject(captured.body) && typeof captured.body.id === "string" ? captured.body.id : undefined;
      if ((captured.status !== 201 && captured.status !== 200) || originalId === undefined) {
        fail(lineNo, "capture", `HTTP ${captured.status}`);
        continue;
      }
      if (captured.status === 201) counts.originals_created++;
      else counts.duplicates++;

      const recScore = readRecordScore(rec, opts.declaredScorer);
      if (recScore === undefined) {
        counts.unscored++;
        continue;
      }
      if (typeof recScore === "string") {
        fail(lineNo, "score", recScore);
        continue;
      }
      const { scorer, scoredAt } = recScore;
      const arxivId = recordArxivId(rec);
      if (arxivId === undefined) {
        fail(lineNo, "score", "record has no arXiv ID");
        continue;
      }
      const dimensionScores = readDimensionScores(recScore.scores, recScore.reasons, [{ id: originalId }], `${file} line ${lineNo}`);
      if (typeof dimensionScores === "string" || dimensionScores.length === 0) {
        fail(lineNo, "score", "scores hold no numeric paper-rubric dimension");
        continue;
      }

      const scoredRes = await post(scoreUrl, {
        item_id: shortId("cr_item_", opts.corpusId, arxivId),
        policy_id: PAPER_RUBRIC_ID,
        policy_version: 1,
        dimension_scores: dimensionScores,
        scorer,
        source_blind: typeof rec.source_blind === "boolean" ? rec.source_blind : false,
        scored_at: scoredAt,
      });
      if (scoredRes.status !== 201) {
        fail(lineNo, "score", `HTTP ${scoredRes.status}`);
        continue;
      }
      counts.scores++;
    }
    log(JSON.stringify({ event: "file", file, ...counts }));
    for (const k of Object.keys(total) as Array<keyof CorpusImportCounts>) total[k] += counts[k];
  }
  log(JSON.stringify({ event: "total", ...total }));
  return total;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  const missing = ["RANKER_IMPORT_DIR", "RANKER_API_URL", "RANKER_API_KEY", "RANKER_CORPUS_ID"].filter((n) => !env[n]);
  if (missing.length > 0) {
    console.error(`corpus import refuses to start: ${missing.join(", ")} not set`);
    process.exit(2);
  }
  try {
    const counts = await runCorpusImport({
      dir: env.RANKER_IMPORT_DIR!,
      apiUrl: env.RANKER_API_URL!,
      apiKey: env.RANKER_API_KEY!,
      corpusId: env.RANKER_CORPUS_ID!,
      capturedBy: env.RANKER_IMPORT_CAPTURED_BY || "agent:corpus-import",
      ...(env.RANKER_IMPORT_DECLARED_SCORER ? { declaredScorer: parseDeclaredScorer(env.RANKER_IMPORT_DECLARED_SCORER) } : {}),
    });
    if (counts.failed > 0) {
      console.error(`corpus import failed: ${counts.failed} record(s) not imported`);
      process.exit(1);
    }
  } catch (e) {
    if (!(e instanceof ExportIntegrityError)) throw e;
    console.error(`corpus import refuses to start: ${e.message}`);
    process.exit(1);
  }
}
