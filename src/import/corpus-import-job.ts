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
// with the captured Original as evidence. The Item a score cites is the one
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
// Secret), RANKER_CORPUS_ID, RANKER_IMPORT_CAPTURED_BY (default agent:corpus-import).
// tests/deploy/corpus-import-job.test.ts holds all of this.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isObject, recordArxivId, shortId, splitLines } from "./jsonl-importer.ts";
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

/** Import the export in `opts.dir`; resolves with the counts (failed > 0 means the import failed). */
export async function runCorpusImport(opts: CorpusImportOptions): Promise<CorpusImportCounts> {
  const files = opts.files ?? WEEKLY_FILES;
  const log = opts.log ?? ((line: string) => process.stdout.write(line + "\n"));
  const doFetch = opts.fetch ?? fetch;
  verifyExport(opts.dir, files);

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

      if (rec.scores === undefined || rec.scores === null) {
        counts.unscored++;
        continue;
      }
      if (!isObject(rec.scores)) {
        fail(lineNo, "score", "scores is not an object");
        continue;
      }
      const scorer = readScorer(rec);
      if (typeof scorer === "string") {
        fail(lineNo, "score", scorer);
        continue;
      }
      const scoredAt = readScoredAt(rec);
      if (typeof scoredAt !== "string") {
        fail(lineNo, "score", "scored_at is missing or not a date");
        continue;
      }
      const arxivId = recordArxivId(rec);
      if (arxivId === undefined) {
        fail(lineNo, "score", "record has no arXiv ID");
        continue;
      }
      const dimensionScores = readDimensionScores(rec.scores, isObject(rec.reasons) ? rec.reasons : {}, [{ id: originalId }], `${file} line ${lineNo}`);
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
