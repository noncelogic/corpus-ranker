// CR-M1-T4 acceptance: replay under a named Policy version records new Score
// events and leaves every prior Score event unaltered (SPEC A3 `replay`, A4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { KernelError, RankerKernel, type DimensionScore, type Policy } from "../../src/kernel/index.ts";
import { loadContracts, schemaUri } from "../../src/contracts/index.ts";
import { examplePolicy, fakeClock, scoreInput } from "./fixtures.ts";

const contracts = loadContracts();

// v2 of the rubric: Technical Merit now weighs triple.
function rubricV2(): Policy {
  const p = examplePolicy(2);
  return { ...p, dimensions: p.dimensions.map((d) => (d.name === "Technical Merit" ? { ...d, weight: 3 } : d)) };
}

function seeded() {
  const k = new RankerKernel({ now: fakeClock() });
  k.createPolicy(examplePolicy(1));
  const dims = (rel: number, merit: number): DimensionScore[] => [
    { dimension: "Relevance", value: rel, reason: "rel", evidence: [] },
    { dimension: "Technical Merit", value: merit, reason: "merit", evidence: [] },
  ];
  const a = k.score(scoreInput({ item_id: "cr_item_a", dimension_scores: dims(5, 1) }));
  const b = k.score(scoreInput({ item_id: "cr_item_b", dimension_scores: dims(2, 5) }));
  const c = k.score(scoreInput({ item_id: "cr_item_c", dimension_scores: dims(3, 3) }));
  k.retractScore({ score_event_id: c.id, reason: "wrong PDF", actor: "joe" });
  return { k, a, b, c };
}

test("replay under a second policy version leaves prior score events unchanged", () => {
  const { k, a, b, c } = seeded();
  k.createPolicy(rubricV2());
  const eventsBefore = structuredClone(k.events());
  const scoresBefore = [a, b, c].map((s) => structuredClone(k.getScore(s.id)));

  const result = k.replay({
    policy_id: "cr_pol_paper",
    from_version: 1,
    to_version: 2,
    corpus_id: "cr_corpus_papers01",
    scorer: { identity: "program:paper-judge", model: "claude-opus-5-5" },
  });

  // Prior events are an untouched prefix of the log; replay only appends.
  const eventsAfter = k.events();
  assert.deepEqual(eventsAfter.slice(0, eventsBefore.length), eventsBefore);
  assert.deepEqual([a, b, c].map((s) => k.getScore(s.id)), scoresBefore);
  assert.equal(k.getScore(c.id)!.retraction_reason, "wrong PDF", "retraction state survives replay");

  // New scores: one per live v1 score (the retracted one is not replayed), cited at v2.
  assert.equal(result.score_events.length, 2);
  assert.deepEqual(result.score_events.map((s) => s.item_id).sort(), ["cr_item_a", "cr_item_b"]);
  for (const s of result.score_events) {
    assert.equal(s.policy_version, 2);
    assert.ok(![a.id, b.id, c.id].includes(s.id), "replay mints new score ids");
    assert.deepEqual(contracts.registry.validate(s, schemaUri("score-event.schema.json")), []);
  }
  assert.equal(eventsAfter.length, eventsBefore.length + 2);

  // Ranking at the old version still answers from the old scores.
  assert.deepEqual(k.liveScores({ policy_id: "cr_pol_paper", policy_version: 1 }).map((s) => s.id).sort(), [a.id, b.id].sort());

  // Diff summary: v1 composites a=5+1, b=2+5; v2 (merit x3) a=5+3, b=2+15.
  const byItem = Object.fromEntries(result.diff.map((d) => [d.item_id, d]));
  assert.deepEqual(byItem["cr_item_a"], { item_id: "cr_item_a", from_composite: 6, to_composite: 8, delta: 2, from_rank: 2, to_rank: 2, rank_change: 0 });
  assert.deepEqual(byItem["cr_item_b"], { item_id: "cr_item_b", from_composite: 7, to_composite: 17, delta: 10, from_rank: 1, to_rank: 1, rank_change: 0 });
});

test("replay refuses versions that do not exist or a mismatched corpus", () => {
  const { k } = seeded();
  const before = structuredClone(k.events());
  const args = { policy_id: "cr_pol_paper", from_version: 1, to_version: 2, corpus_id: "cr_corpus_papers01", scorer: { identity: "joe" } };
  assert.throws(() => k.replay(args), (e: unknown) => e instanceof KernelError && e.code === "policy_version_not_found");
  k.createPolicy(rubricV2());
  assert.throws(() => k.replay({ ...args, corpus_id: "cr_corpus_other" }), (e: unknown) => e instanceof KernelError && e.code === "corpus_mismatch");
  assert.throws(() => k.replay({ ...args, from_version: 2, to_version: 2 }), (e: unknown) => e instanceof KernelError && e.code === "invalid_replay");
  assert.deepEqual(k.events(), [...before, k.events().at(-1)], "only the v2 policy creation was appended");
});

test("replay with a re-scoring function records its new dimension scores", () => {
  const { k, a } = seeded();
  k.createPolicy(rubricV2());
  const result = k.replay({
    policy_id: "cr_pol_paper",
    from_version: 1,
    to_version: 2,
    corpus_id: "cr_corpus_papers01",
    scorer: { identity: "joe" },
    rescore: (prior) =>
      prior.item_id === a.item_id
        ? prior.dimension_scores.map((d) => (d.dimension === "Technical Merit" ? { ...d, value: 5, reason: "re-read: strong" } : d))
        : prior.dimension_scores,
  });
  const newA = result.score_events.find((s) => s.item_id === a.item_id)!;
  assert.equal(newA.dimension_scores.find((d) => d.dimension === "Technical Merit")!.value, 5);
  assert.equal(k.getScore(a.id)!.dimension_scores.find((d) => d.dimension === "Technical Merit")!.value, 1);
  const byItem = Object.fromEntries(result.diff.map((d) => [d.item_id, d]));
  assert.equal(byItem["cr_item_a"]!.to_composite, 20);
  assert.equal(byItem["cr_item_a"]!.to_rank, 1);
  assert.equal(byItem["cr_item_a"]!.rank_change, 1);
});
