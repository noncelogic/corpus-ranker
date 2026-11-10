// CR-M2-T2 acceptance: the existing Relevance + Technical Merit rubric is
// encoded as Policy paper-rubric v1, and historical scores from the JSONL
// corpus exist as Score events under it with scorer and date preserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadContracts, schemaUri } from "../../src/contracts/index.ts";
import { CorpusStore, importPapersJsonl } from "../../src/import/jsonl-importer.ts";
import { PAPER_RUBRIC_ID, paperRubricV1 } from "../../src/import/paper-rubric.ts";
import { importScoresJsonl } from "../../src/import/score-import.ts";
import { RankerKernel } from "../../src/kernel/index.ts";
import { fakeClock } from "../kernel/fixtures.ts";

const FILE = "scored-papers-2026-W41.jsonl";
const fixture = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", FILE));
const lines = fixture.toString("utf8").split("\n");
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const CORPUS = "cr_corpus_papers01";
const NOW = "2026-11-10T00:00:00Z";
const contracts = loadContracts();

function setup() {
  const store = new CorpusStore();
  importPapersJsonl(fixture, store, {
    corpusId: CORPUS,
    source: FILE,
    importedBy: "agent:import-jsonl",
    now: NOW,
    storageUriPrefix: "s3://ranker-originals/",
  });
  const kernel = new RankerKernel({ now: fakeClock(NOW) });
  const policy = kernel.createPolicy(paperRubricV1({ corpusId: CORPUS, createdBy: "joe", createdAt: NOW }));
  return { store, kernel, policy };
}

const scoreOptions = { corpusId: CORPUS, source: FILE };

test("the Relevance + Technical Merit rubric is Policy paper-rubric v1", () => {
  const policy = paperRubricV1({ corpusId: CORPUS, createdBy: "joe", createdAt: NOW });
  assert.deepEqual(contracts.registry.validate(policy, schemaUri("policy.schema.json")), []);
  assert.equal(policy.id, PAPER_RUBRIC_ID);
  assert.equal(policy.name, "paper-rubric");
  assert.equal(policy.version, 1);
  assert.equal(policy.supersedes_version, null);
  assert.deepEqual(
    policy.dimensions.map((d) => [d.name, d.scale, d.weight]),
    [
      ["Relevance", { kind: "integer", min: 1, max: 5 }, 1],
      ["Technical Merit", { kind: "integer", min: 1, max: 5 }, 1],
    ],
  );
  for (const d of policy.dimensions) assert.deepEqual(Object.keys(d.definition), ["1", "2", "3", "4", "5"], d.name);
  assert.equal(policy.composite_rule.method, "weighted_sum");
});

test("historical scores exist as Score events under paper-rubric v1 with scorer and date preserved", () => {
  const { store, kernel, policy } = setup();
  const report = importScoresJsonl(fixture, store, kernel, scoreOptions);

  const events = kernel.liveScores({ policy_id: PAPER_RUBRIC_ID, policy_version: 1 });
  for (const e of events) assert.deepEqual(contracts.registry.validate(e, schemaUri("score-event.schema.json")), [], e.id);
  assert.equal(events.length, 3);

  const p1 = store.itemByArxivId("2610.04512")!;
  const p2 = store.itemByArxivId("2610.05123")!;

  // A human score: scorer kept, a date-only record date kept as that day (UTC).
  const [first, rescored] = events.filter((e) => e.item_id === p1.id);
  assert.ok(first && rescored);
  assert.equal(first.policy_id, policy.id);
  assert.equal(first.policy_version, 1);
  assert.deepEqual(first.scorer, { identity: "joe" });
  assert.equal(first.scored_at, "2026-10-05T00:00:00Z");
  assert.equal(first.source_blind, false);
  assert.deepEqual(first.dimension_scores, [
    {
      dimension: "Relevance",
      value: 5,
      reason: "Directly on agent context management.",
      evidence: [{ id: store.originalByHash(CORPUS, sha256(lines[0]!))!.id }],
    },
    {
      dimension: "Technical Merit",
      value: 5,
      reason: "Strong ablations; code released.",
      evidence: [{ id: store.originalByHash(CORPUS, sha256(lines[0]!))!.id }],
    },
  ]);

  // The same paper scored again in a later record: a second event, history kept.
  assert.equal(rescored.scored_at, "2026-10-12T18:40:00Z");
  assert.deepEqual(
    rescored.dimension_scores.map((d) => [d.dimension, d.value]),
    [["Relevance", 5], ["Technical Merit", 4]],
  );

  // A judge score: scorer identity and model kept, full timestamp kept.
  const judged = events.find((e) => e.item_id === p2.id)!;
  assert.deepEqual(judged.scorer, { identity: "program:paper-judge", model: "claude-opus-4-1" });
  assert.equal(judged.scored_at, "2026-10-06T09:15:00Z");
  // No reason in the file: the reason says so rather than inventing one.
  for (const d of judged.dimension_scores) assert.match(d.reason, /no reason recorded/i);

  // Scores are not fabricated: unscored records yield none; incomplete or invalid ones are reported.
  assert.equal(events.some((e) => e.item_id === store.itemByArxivId("2610.06001")!.id), false);
  assert.deepEqual(report.scoresImported, 3);
  assert.deepEqual(report.unscoredRecords, 1);
  assert.deepEqual(report.errors.map((e) => e.line), [4, 5]);
  assert.match(report.errors[0]!.message, /scorer/);
  assert.match(report.errors[1]!.message, /outside 1\.\.5/);

  // Re-importing the file records nothing new.
  const again = importScoresJsonl(fixture, store, kernel, scoreOptions);
  assert.equal(again.scoresImported, 0);
  assert.equal(again.alreadyImported, 3);
  assert.equal(kernel.liveScores({ policy_id: PAPER_RUBRIC_ID, policy_version: 1 }).length, 3);
});

test("a score for a paper that was never imported as an Item is reported", () => {
  const { kernel } = setup();
  const report = importScoresJsonl(fixture, new CorpusStore(), kernel, scoreOptions);
  assert.equal(report.scoresImported, 0);
  assert.ok(report.errors.every((e) => /no Item/.test(e.message) || /scorer/.test(e.message)));
});
