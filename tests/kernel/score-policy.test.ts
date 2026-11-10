// CR-M1-T4 acceptance: a Score event is recorded only against an existing
// Policy version, and retraction is recorded as a new event (SPEC A2.6, A2.7, A4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { KernelError, RankerKernel } from "../../src/kernel/index.ts";
import { loadContracts, schemaUri } from "../../src/contracts/index.ts";
import { examplePolicy, fakeClock, scoreInput } from "./fixtures.ts";

const contracts = loadContracts();

function kernel(): RankerKernel {
  return new RankerKernel({ now: fakeClock() });
}

test("score events require an existing policy version", () => {
  const k = kernel();

  // No policy at all.
  assert.throws(() => k.score(scoreInput()), (e: unknown) => e instanceof KernelError && e.code === "policy_not_found");
  assert.equal(k.events().length, 0, "a rejected score appends nothing");

  k.createPolicy(examplePolicy(1));

  // Policy exists, but the cited version does not.
  assert.throws(
    () => k.score(scoreInput({ policy_version: 2 })),
    (e: unknown) => e instanceof KernelError && e.code === "policy_version_not_found",
  );
  // Unknown policy id.
  assert.throws(
    () => k.score(scoreInput({ policy_id: "cr_pol_other" })),
    (e: unknown) => e instanceof KernelError && e.code === "policy_not_found",
  );
  assert.equal(k.events().filter((e) => e.type === "score_recorded").length, 0);

  // Existing version: recorded, and the result is a contract-valid Score event.
  const recorded = k.score(scoreInput());
  assert.equal(recorded.policy_version, 1);
  assert.deepEqual(contracts.registry.validate(recorded, schemaUri("score-event.schema.json")), []);
  assert.deepEqual(k.getScore(recorded.id), recorded);
});

test("score is validated against the cited policy version", () => {
  const k = kernel();
  k.createPolicy(examplePolicy(1));
  const rejects = (input: ReturnType<typeof scoreInput>, code: string) =>
    assert.throws(() => k.score(input), (e: unknown) => e instanceof KernelError && e.code === code, code);

  rejects(scoreInput({ dimension_scores: [{ dimension: "Novelty", value: 3, reason: "x", evidence: [] }] }), "invalid_score");
  rejects(scoreInput({ dimension_scores: [{ dimension: "Relevance", value: 9, reason: "x", evidence: [] }] }), "invalid_score");
  rejects(scoreInput({ dimension_scores: [{ dimension: "Relevance", value: 2.5, reason: "x", evidence: [] }] }), "invalid_score");
  rejects(scoreInput({ dimension_scores: [{ dimension: "Relevance", value: 3, reason: "", evidence: [] }] }), "invalid_score");
  rejects(scoreInput({ scorer: { identity: "program:someone-else" } }), "scorer_not_allowed");
  assert.equal(k.events().filter((e) => e.type === "score_recorded").length, 0);
});

test("policy versions are created in order and are immutable", () => {
  const k = kernel();
  // Version 2 cannot precede version 1.
  assert.throws(() => k.createPolicy(examplePolicy(2)), (e: unknown) => e instanceof KernelError && e.code === "invalid_policy_version");
  k.createPolicy(examplePolicy(1));
  // A version is never edited by re-creating it.
  assert.throws(() => k.createPolicy({ ...examplePolicy(1), name: "paper-rubric" }), (e: unknown) => e instanceof KernelError && e.code === "invalid_policy_version");
  // Schema-invalid policies are refused.
  assert.throws(() => k.createPolicy({ ...examplePolicy(2), dimensions: [] }), (e: unknown) => e instanceof KernelError && e.code === "invalid_policy");
  k.createPolicy(examplePolicy(2));
  assert.deepEqual(k.listPolicyVersions("cr_pol_paper"), [1, 2]);

  // Returned and stored policies cannot be mutated from outside.
  const v1 = k.getPolicy("cr_pol_paper", 1)!;
  assert.throws(() => { (v1 as { name: string }).name = "changed"; });
  assert.equal(k.getPolicy("cr_pol_paper", 1)!.name, "paper-rubric");
});

test("retraction is recorded as a new event; the score stays in history", () => {
  const k = kernel();
  k.createPolicy(examplePolicy(1));
  const recorded = k.score(scoreInput());
  const recordedEvent = structuredClone(k.events().find((e) => e.type === "score_recorded"));
  const before = k.events().length;

  const retracted = k.retractScore({ score_event_id: recorded.id, reason: "Judge read the wrong PDF.", actor: "joe" });

  const events = k.events();
  assert.equal(events.length, before + 1, "retraction appends exactly one event");
  const last = events.at(-1)!;
  assert.equal(last.type, "score_retracted");
  assert.equal(last.type === "score_retracted" && last.score_event_id, recorded.id);
  assert.deepEqual(events.find((e) => e.type === "score_recorded"), recordedEvent, "the recorded event is untouched");

  assert.equal(retracted.id, recorded.id);
  assert.equal(retracted.retracted_by, "joe");
  assert.equal(retracted.retraction_reason, "Judge read the wrong PDF.");
  assert.ok(retracted.retracted_at);
  assert.deepEqual(contracts.registry.validate(retracted, schemaUri("score-event.schema.json")), []);
  assert.deepEqual(k.getScore(recorded.id), retracted);
  assert.deepEqual(k.liveScores({ policy_id: "cr_pol_paper", policy_version: 1 }), [], "retracted scores are excluded");

  // Cannot retract twice, retract an unknown score, or retract without a reason.
  assert.throws(() => k.retractScore({ score_event_id: recorded.id, reason: "again", actor: "joe" }), (e: unknown) => e instanceof KernelError && e.code === "already_retracted");
  assert.throws(() => k.retractScore({ score_event_id: "cr_score_nope", reason: "x", actor: "joe" }), (e: unknown) => e instanceof KernelError && e.code === "score_not_found");
  const other = k.score(scoreInput());
  assert.throws(() => k.retractScore({ score_event_id: other.id, reason: "", actor: "joe" }), (e: unknown) => e instanceof KernelError && e.code === "invalid_retraction");
});
