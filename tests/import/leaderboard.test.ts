// CR-M2-T3 acceptance: a Ranked View over the imported corpus reproduces the
// JSONL-derived all-time leaderboard (incl. the papers at 5+5), and any
// mismatch is reported as data, not prose (SPEC §A7 Phase 0 exit check).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadContracts, schemaUri } from "../../src/contracts/index.ts";
import { CorpusStore, importPapersJsonl } from "../../src/import/jsonl-importer.ts";
import { compareLeaderboards, jsonlLeaderboard, viewLeaderboard } from "../../src/import/leaderboard.ts";
import { PAPER_RUBRIC_ID, paperRubricV1 } from "../../src/import/paper-rubric.ts";
import { importScoresJsonl } from "../../src/import/score-import.ts";
import { RankerKernel } from "../../src/kernel/index.ts";
import { rank } from "../../src/rank/ranked-view.ts";
import { fakeClock } from "../kernel/fixtures.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS = "cr_corpus_papers01";
const NOW = "2026-11-10T00:00:00Z";
const contracts = loadContracts();

interface WeeklyFile {
  name: string;
  data: Uint8Array | string;
}

/** Imports weekly files the Phase 0 way (papers, then scores) and ranks the whole corpus under paper-rubric v1. */
function importAndRank(files: WeeklyFile[]) {
  const store = new CorpusStore();
  const kernel = new RankerKernel({ now: fakeClock(NOW) });
  const policy = kernel.createPolicy(paperRubricV1({ corpusId: CORPUS, createdBy: "joe", createdAt: NOW }));
  const common = { corpusId: CORPUS, importedBy: "agent:import-jsonl", now: NOW, storageUriPrefix: "s3://ranker-originals/" };
  for (const f of files) importPapersJsonl(f.data, store, { ...common, source: f.name });
  const scoreReports = files.map((f) => importScoresJsonl(f.data, store, kernel, { corpusId: CORPUS, source: f.name }));
  const view = rank(kernel, store, {
    id: "cr_view_alltime01",
    name: "all-time-leaderboard",
    corpus_id: CORPUS,
    policy_id: PAPER_RUBRIC_ID,
    policy_version: 1,
    query: { subject: "all-time leaderboard" },
    computed_at: NOW,
  });
  return { store, kernel, policy, view, scoreReports };
}

const fixtureFiles: WeeklyFile[] = ["papers-2026-W42.jsonl", "papers-2026-W43.jsonl"].map((name) => ({
  name,
  data: readFileSync(join(here, "fixtures", "leaderboard", name)),
}));

test("ranked view over a fixture corpus reproduces the expected leaderboard order and counts", () => {
  const { store, kernel, view, scoreReports } = importAndRank(fixtureFiles);
  for (const r of scoreReports) assert.deepEqual(r.errors, []);

  // The view is a contract Ranked View citing the exact Score events used.
  assert.deepEqual(contracts.registry.validate(view, schemaUri("ranked-view.schema.json")), []);
  assert.equal(view.stale, false);
  assert.deepEqual(view.entries.map((e) => e.rank), view.entries.map((_, i) => i + 1));
  for (const e of view.entries) {
    assert.equal(e.score_event_ids.length, 1);
    assert.equal(kernel.getScore(e.score_event_ids[0]!)!.item_id, e.item_id);
  }

  // Expected all-time leaderboard, worked out by hand from the fixture: latest score
  // per paper (by scored_at), composite = Relevance + Technical Merit, ties broken
  // by Relevance then Technical Merit; equal keys share a rank.
  const expected: [arxiv: string, rank: number, rel: number, tm: number][] = [
    ["2610.10001", 1, 5, 5],
    ["2610.10006", 1, 5, 5], // rescored 4+4 → 5+5 in W43
    ["2610.10007", 1, 5, 5],
    ["2610.10002", 4, 5, 4],
    ["2610.10003", 5, 4, 5], // a later-filed but earlier-dated 4+4 does not displace 4+5
    ["2610.10009", 5, 4, 5],
    ["2610.10010", 7, 5, 3],
    ["2610.10011", 8, 4, 4],
    ["2610.10004", 9, 3, 3],
    ["2610.10008", 10, 2, 4],
  ];
  const toRows = (lb: ReturnType<typeof jsonlLeaderboard>) =>
    lb.rows.map((r) => [r.arxiv_id, r.rank, r.scores.Relevance, r.scores["Technical Merit"]]);
  const expectedCounts = { ranked: 10, top: 3, by_composite: { "10": 3, "9": 3, "8": 2, "6": 2 } };

  const fromJsonl = jsonlLeaderboard(fixtureFiles.map((f) => f.data));
  assert.deepEqual(toRows(fromJsonl), expected);
  assert.deepEqual(fromJsonl.counts, expectedCounts);

  const fromView = viewLeaderboard(view, kernel, store);
  // Within a tie the view orders by item id; compare as rank-ordered sets.
  const byRank = (rows: unknown[][]) => [...rows].sort((a, b) => (a[1] as number) - (b[1] as number) || String(a[0]).localeCompare(String(b[0])));
  assert.deepEqual(byRank(toRows(fromView)), expected);
  assert.deepEqual(fromView.counts, expectedCounts);
  // The unscored paper is in the corpus but not on the leaderboard.
  assert.ok(store.itemByArxivId("2610.10005"));
  assert.equal(view.entries.some((e) => e.item_id === store.itemByArxivId("2610.10005")!.id), false);

  assert.deepEqual(compareLeaderboards(fromJsonl, fromView), { matches: true, expected: expectedCounts, actual: expectedCounts, mismatches: [] });
});

test("a generated all-time corpus reproduces with exactly 70 papers at 5+5", () => {
  // Four weekly files, 300 papers. 69 start at 5+5; two of those are later
  // rescored down; three are later rescored up from 4+5: 70 end at 5+5.
  const weeks: string[][] = [[], [], [], []];
  const rec = (i: number, rel: number, tm: number, day: number, scorer = "joe") =>
    JSON.stringify({
      arxiv_id: `2610.${String(20000 + i)}`,
      title: `Generated paper ${i}`,
      scores: { relevance: rel, technical_merit: tm },
      scorer,
      scored_at: `2026-10-${String(day).padStart(2, "0")}`,
    });
  for (let i = 0; i < 300; i++) {
    const week = i % 4;
    const day = 5 + week * 7;
    let rel: number, tm: number;
    if (i < 69) [rel, tm] = [5, 5];
    else if (i < 72) [rel, tm] = [4, 5];
    else {
      rel = 1 + ((i * 7) % 5);
      tm = 1 + ((i * 3) % 5);
      if (rel === 5 && tm === 5) tm = 4;
    }
    weeks[week]!.push(rec(i, rel, tm, day, i % 2 ? "joe" : "program:paper-judge"));
  }
  weeks[3]!.push(rec(0, 5, 4, 30), rec(1, 4, 4, 30), rec(69, 5, 5, 30), rec(70, 5, 5, 30), rec(71, 5, 5, 30));
  const files = weeks.map((lines, w) => ({ name: `papers-2026-W4${w + 1}.jsonl`, data: `${lines.join("\n")}\n` }));

  const { store, kernel, view } = importAndRank(files);
  const fromJsonl = jsonlLeaderboard(files.map((f) => f.data));
  const fromView = viewLeaderboard(view, kernel, store);

  assert.equal(fromJsonl.counts.ranked, 300);
  assert.equal(fromJsonl.counts.top, 70);
  assert.equal(fromView.counts.top, 70);
  assert.deepEqual(view.entries.slice(0, 70).map((e) => e.composite), Array(70).fill(10));
  assert.equal(view.entries[70]!.composite < 10, true);
  const report = compareLeaderboards(fromJsonl, fromView);
  assert.deepEqual(report.mismatches, []);
  assert.equal(report.matches, true);
});

test("a leaderboard mismatch is reported as data", () => {
  // The W41 file holds two scored records the import refuses (no scorer; off the
  // 1..5 scale). The naive JSONL leaderboard still counts them, so the view cannot match.
  const name = "scored-papers-2026-W41.jsonl";
  const files = [{ name, data: readFileSync(join(here, "fixtures", name)) }];
  const { store, kernel, view } = importAndRank(files);
  const report = compareLeaderboards(jsonlLeaderboard(files.map((f) => f.data)), viewLeaderboard(view, kernel, store));

  assert.equal(report.matches, false);
  assert.deepEqual(report.expected, { ranked: 4, top: 0, by_composite: { "10": 1, "9": 1, "7": 1, "6": 1 } });
  assert.deepEqual(report.actual, { ranked: 2, top: 0, by_composite: { "9": 1, "7": 1 } });
  assert.deepEqual(report.mismatches, [
    { kind: "missing_from_view", arxiv_id: "2610.06003", expected: { rank: 1, composite: 10, scores: { Relevance: 7, "Technical Merit": 3 } }, actual: null },
    { kind: "rank", arxiv_id: "2610.04512", expected: 2, actual: 1 },
    { kind: "rank", arxiv_id: "2610.05123", expected: 3, actual: 2 },
    { kind: "missing_from_view", arxiv_id: "2610.06002", expected: { rank: 4, composite: 6, scores: { Relevance: 3, "Technical Merit": 3 } }, actual: null },
    { kind: "count", arxiv_id: null, field: "ranked", expected: 4, actual: 2 },
    { kind: "count", arxiv_id: null, field: "by_composite.10", expected: 1, actual: 0 },
    { kind: "count", arxiv_id: null, field: "by_composite.6", expected: 1, actual: 0 },
  ]);

  // A score that differs is reported per dimension, with both values.
  const live = kernel.liveScores({ policy_id: PAPER_RUBRIC_ID, policy_version: 1 });
  const latest = live.find((s) => s.scored_at === "2026-10-12T18:40:00Z")!;
  kernel.retractScore({ score_event_id: latest.id, reason: "test: fall back to the earlier score", actor: "joe" });
  const rerank = rank(kernel, store, { ...view, id: "cr_view_alltime02", computed_at: NOW });
  const again = compareLeaderboards(jsonlLeaderboard(files.map((f) => f.data)), viewLeaderboard(rerank, kernel, store));
  assert.deepEqual(
    again.mismatches.filter((m) => m.arxiv_id === "2610.04512"),
    [
      { kind: "composite", arxiv_id: "2610.04512", expected: 9, actual: 10 },
      { kind: "dimension", arxiv_id: "2610.04512", field: "Technical Merit", expected: 4, actual: 5 },
      { kind: "rank", arxiv_id: "2610.04512", expected: 2, actual: 1 },
    ],
  );
});
