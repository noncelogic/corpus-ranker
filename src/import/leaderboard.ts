// Phase 0 exit check (SPEC §A7): the all-time leaderboard derived straight from
// the weekly JSONL files must be reproduced by a Ranked View over the imported
// corpus. Both sides are reduced to the same Leaderboard shape and compared;
// every difference comes back as a structured mismatch record.
//
// The JSONL side is derived independently of the kernel, the way the existing
// leaderboard is: each paper's latest scored record (greatest scored_at; a tie
// goes to the later record), composite = Relevance + Technical Merit, ties
// broken by Relevance then Technical Merit. Records are taken as written: a
// score the import refused still counts here, and so surfaces as a mismatch.
import type { RankerKernel } from "../kernel/index.ts";
import type { RankedView } from "../rank/ranked-view.ts";
import { isObject, recordArxivId, splitLines, type CorpusStore } from "./jsonl-importer.ts";
import { DIMENSION_KEYS, pick } from "./score-import.ts";

/** The paper rubric's dimensions, in tie-break order. */
const DIMENSIONS = DIMENSION_KEYS.map(([dimension]) => dimension);
/** Top of the paper rubric's 1–5 scale: a "5+5" paper has every dimension here. */
const SCALE_MAX = 5;

export interface LeaderboardRow {
  arxiv_id: string;
  /** Competition rank: rows with equal composite and tie-break scores share a rank. */
  rank: number;
  composite: number;
  scores: Record<string, number>;
}

export interface LeaderboardCounts {
  ranked: number;
  /** Papers with every dimension at the top of the scale (5+5). */
  top: number;
  /** Composite value → number of papers. */
  by_composite: Record<string, number>;
}

export interface Leaderboard {
  rows: LeaderboardRow[];
  counts: LeaderboardCounts;
}

export type LeaderboardMismatch =
  | { kind: "missing_from_view"; arxiv_id: string; expected: Omit<LeaderboardRow, "arxiv_id">; actual: null }
  | { kind: "extra_in_view"; arxiv_id: string; expected: null; actual: Omit<LeaderboardRow, "arxiv_id"> }
  | { kind: "composite" | "rank"; arxiv_id: string; expected: number; actual: number }
  | { kind: "dimension"; arxiv_id: string; field: string; expected: number | null; actual: number | null }
  | { kind: "count"; arxiv_id: null; field: string; expected: number; actual: number };

export interface LeaderboardComparison {
  matches: boolean;
  expected: LeaderboardCounts;
  actual: LeaderboardCounts;
  mismatches: LeaderboardMismatch[];
}

const sortKey = (r: { composite: number; scores: Record<string, number> }) => [r.composite, ...DIMENSIONS.map((d) => r.scores[d] ?? -Infinity)];
const sameKey = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const compareKeys = (a: number[], b: number[]) => {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return b[i]! - a[i]!;
  return 0;
};

/** Assigns competition ranks to rows already in leaderboard order, and counts them. */
function finish(ordered: Omit<LeaderboardRow, "rank">[]): Leaderboard {
  const rows: LeaderboardRow[] = [];
  ordered.forEach((r, i) => {
    const prev = rows[i - 1];
    const rank = prev !== undefined && sameKey(sortKey(prev), sortKey(r)) ? prev.rank : i + 1;
    rows.push({ arxiv_id: r.arxiv_id, rank, composite: r.composite, scores: r.scores });
  });
  const by_composite: Record<string, number> = {};
  for (const r of rows) by_composite[String(r.composite)] = (by_composite[String(r.composite)] ?? 0) + 1;
  const top = rows.filter((r) => DIMENSIONS.every((d) => r.scores[d] === SCALE_MAX)).length;
  return { rows, counts: { ranked: rows.length, top, by_composite } };
}

function scoredAtMillis(raw: unknown): number {
  if (typeof raw !== "string") return -Infinity;
  const s = raw.trim();
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : s);
  return Number.isNaN(t) ? -Infinity : t;
}

/** The all-time leaderboard derived directly from weekly papers JSONL files, given in import order. */
export function jsonlLeaderboard(files: (Uint8Array | string)[]): Leaderboard {
  const latest = new Map<string, { at: number; scores: Record<string, number> }>();
  for (const file of files) {
    for (const line of splitLines(typeof file === "string" ? Buffer.from(file, "utf8") : file)) {
      let rec: unknown;
      try {
        rec = JSON.parse(line.toString("utf8"));
      } catch {
        continue;
      }
      if (!isObject(rec) || !isObject(rec.scores)) continue;
      const arxivId = recordArxivId(rec);
      if (arxivId === undefined) continue;
      const scores: Record<string, number> = {};
      for (const [dimension, keys] of DIMENSION_KEYS) {
        const v = pick(rec.scores, keys);
        if (typeof v === "number") scores[dimension] = v;
      }
      if (Object.keys(scores).length === 0) continue;
      const at = scoredAtMillis(rec.scored_at);
      const prev = latest.get(arxivId);
      if (prev === undefined || at >= prev.at) latest.set(arxivId, { at, scores });
    }
  }
  const rows = [...latest].map(([arxiv_id, { scores }]) => ({
    arxiv_id,
    composite: Object.values(scores).reduce((a, b) => a + b, 0),
    scores,
  }));
  rows.sort((a, b) => compareKeys(sortKey(a), sortKey(b)) || (a.arxiv_id < b.arxiv_id ? -1 : a.arxiv_id > b.arxiv_id ? 1 : 0));
  return finish(rows);
}

/** The leaderboard a Ranked View presents, in the view's own order, keyed by arXiv ID (item id if it has none). */
export function viewLeaderboard(view: RankedView, kernel: RankerKernel, store: CorpusStore): Leaderboard {
  const rows = [...view.entries]
    .sort((a, b) => a.rank - b.rank)
    .map((e) => {
      const scores: Record<string, number> = {};
      for (const id of e.score_event_ids) {
        for (const d of kernel.getScore(id)?.dimension_scores ?? []) scores[d.dimension] = d.value;
      }
      const arxiv_id = store.item(e.item_id)?.identity_keys.arxiv_id ?? e.item_id;
      return { arxiv_id, composite: e.composite, scores };
    });
  return finish(rows);
}

/** Compares a view's leaderboard against the expected (JSONL-derived) one; every difference is one record. */
export function compareLeaderboards(expected: Leaderboard, actual: Leaderboard): LeaderboardComparison {
  const mismatches: LeaderboardMismatch[] = [];
  const actualById = new Map(actual.rows.map((r) => [r.arxiv_id, r]));
  const strip = ({ arxiv_id: _, ...rest }: LeaderboardRow) => rest;

  for (const e of expected.rows) {
    const a = actualById.get(e.arxiv_id);
    if (a === undefined) {
      mismatches.push({ kind: "missing_from_view", arxiv_id: e.arxiv_id, expected: strip(e), actual: null });
      continue;
    }
    if (a.composite !== e.composite) mismatches.push({ kind: "composite", arxiv_id: e.arxiv_id, expected: e.composite, actual: a.composite });
    for (const dim of new Set([...Object.keys(e.scores), ...Object.keys(a.scores)])) {
      const ev = e.scores[dim] ?? null;
      const av = a.scores[dim] ?? null;
      if (ev !== av) mismatches.push({ kind: "dimension", arxiv_id: e.arxiv_id, field: dim, expected: ev, actual: av });
    }
    if (a.rank !== e.rank) mismatches.push({ kind: "rank", arxiv_id: e.arxiv_id, expected: e.rank, actual: a.rank });
  }
  const expectedIds = new Set(expected.rows.map((r) => r.arxiv_id));
  for (const a of actual.rows) {
    if (!expectedIds.has(a.arxiv_id)) mismatches.push({ kind: "extra_in_view", arxiv_id: a.arxiv_id, expected: null, actual: strip(a) });
  }

  const count = (field: string, ev: number, av: number) => {
    if (ev !== av) mismatches.push({ kind: "count", arxiv_id: null, field, expected: ev, actual: av });
  };
  count("ranked", expected.counts.ranked, actual.counts.ranked);
  count("top", expected.counts.top, actual.counts.top);
  const composites = [...new Set([...Object.keys(expected.counts.by_composite), ...Object.keys(actual.counts.by_composite)])];
  composites.sort((a, b) => Number(b) - Number(a));
  for (const c of composites) count(`by_composite.${c}`, expected.counts.by_composite[c] ?? 0, actual.counts.by_composite[c] ?? 0);

  return { matches: mismatches.length === 0, expected: expected.counts, actual: actual.counts, mismatches };
}
