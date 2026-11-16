// CR-M4-T1 acceptance: a migration seeds the funding corpus (item types
// program and investor) and Policy funding-fit v1 (Fit / Timing / Deadline /
// Value, equal weights), so a funding item can be scored and ranked under it
// (SPEC §A7 Phase 2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadContracts, schemaUri } from "../../src/contracts/index.ts";
import {
  FUNDING_CORPUS_ID,
  FUNDING_CORPUS_NAME,
  FUNDING_FIT_DIMENSIONS,
  FUNDING_FIT_ID,
  FUNDING_FIT_NAME,
  FUNDING_ITEM_TYPES,
  fundingFitV1,
} from "../../src/funding/funding-fit.ts";
import { CorpusStore, type Item } from "../../src/import/jsonl-importer.ts";
import { composite, RankerKernel, type DimensionScore, type Policy } from "../../src/kernel/index.ts";
import { rank } from "../../src/rank/ranked-view.ts";
import { fakeClock } from "../kernel/fixtures.ts";
import { freshDatabase } from "../schema/fresh-db.ts";

const NOW = "2026-11-16T00:00:00Z";
const contracts = loadContracts();

function fundingItem(id: string, itemType: (typeof FUNDING_ITEM_TYPES)[number], title: string): Item {
  return {
    id,
    corpus_id: FUNDING_CORPUS_ID,
    item_type: itemType,
    title,
    summary: null,
    canonical_fields: {},
    original_ids: [],
    identity_keys: {},
    status: "active",
    created_at: NOW,
    updated_at: NOW,
  };
}

function scores(fit: number, timing: number, deadline: number, value: number): DimensionScore[] {
  return [
    { dimension: "Fit", value: fit, reason: "fit", evidence: [] },
    { dimension: "Timing", value: timing, reason: "timing", evidence: [] },
    { dimension: "Deadline", value: deadline, reason: "deadline", evidence: [] },
    { dimension: "Value", value: value, reason: "value", evidence: [] },
  ];
}

test("the funding-fit v1 policy scores a program on Fit, Timing, Deadline and Value", { timeout: 600_000 }, async (t) => {
  const db = await freshDatabase(t);
  const q = db.psql;

  // The migration seeds the funding corpus, naming its item types.
  assert.equal(q(`select name || '|' || status from corpora where id = '${FUNDING_CORPUS_ID}'`), `${FUNDING_CORPUS_NAME}|active`);
  const description = q(`select description from corpora where id = '${FUNDING_CORPUS_ID}'`);
  for (const type of FUNDING_ITEM_TYPES) assert.match(description, new RegExp(`\\b${type}\\b`));
  assert.deepEqual([...FUNDING_ITEM_TYPES], ["program", "investor"]);

  // ...and Policy funding-fit v1, exactly as the code defines it.
  const row = JSON.parse(
    q(`select json_build_object(
         'id', id, 'name', name, 'corpus_id', corpus_id, 'version', version,
         'dimensions', dimensions, 'judge_config', judge_config, 'composite_rule', composite_rule,
         'created_by', created_by, 'created_at', to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
         'supersedes_version', supersedes_version)
       from policies where id = '${FUNDING_FIT_ID}'`),
  ) as Policy;
  const policy = fundingFitV1();
  assert.deepEqual(row, policy);
  assert.deepEqual(contracts.registry.validate(row, schemaUri("policy.schema.json")), []);
  assert.equal(row.name, FUNDING_FIT_NAME);
  assert.equal(row.version, 1);
  assert.equal(row.supersedes_version, null);
  assert.deepEqual(row.dimensions.map((d) => d.name), ["Fit", "Timing", "Deadline", "Value"]);
  assert.deepEqual([...FUNDING_FIT_DIMENSIONS], ["Fit", "Timing", "Deadline", "Value"]);
  // Equal weights in v1.
  assert.deepEqual(new Set(row.dimensions.map((d) => d.weight)), new Set([1]));

  // A program is scored on all four dimensions under the seeded version.
  const kernel = new RankerKernel({ now: fakeClock(NOW) });
  kernel.createPolicy(row);
  const score = kernel.score({
    item_id: "cr_item_fundprog1",
    policy_id: FUNDING_FIT_ID,
    policy_version: 1,
    dimension_scores: scores(5, 4, 3, 4),
    scorer: { identity: "joe" },
    source_blind: false,
  });
  assert.deepEqual(score.dimension_scores.map((d) => d.dimension), ["Fit", "Timing", "Deadline", "Value"]);
  assert.equal(composite(row, score.dimension_scores), 16);
  // A dimension outside funding-fit v1 is refused.
  assert.throws(() =>
    kernel.score({
      item_id: "cr_item_fundprog1",
      policy_id: FUNDING_FIT_ID,
      policy_version: 1,
      dimension_scores: [{ dimension: "Relevance", value: 5, reason: "x", evidence: [] }],
      scorer: { identity: "joe" },
      source_blind: false,
    }),
  );

  // The database accepts a program item and its Score event under the seeded policy.
  q(`
    insert into items (id, corpus_id, item_type, title)
      values ('cr_item_fundprog1', '${FUNDING_CORPUS_ID}', 'program', 'Seed Grant Program');
    insert into score_events (id, item_id, policy_id, policy_version, dimension_scores, scorer, scored_at, source_blind)
      values ('${score.id}', 'cr_item_fundprog1', '${FUNDING_FIT_ID}', 1,
              '${JSON.stringify(score.dimension_scores)}', '${JSON.stringify(score.scorer)}', '${score.scored_at}', false);
  `);
  assert.equal(
    q(`select s.policy_version || '|' || i.item_type from score_events s join items i on i.id = s.item_id
         where s.policy_id = '${FUNDING_FIT_ID}'`),
    "1|program",
  );
});

test("a funding item ranks under funding-fit v1 in a ranked view", () => {
  const kernel = new RankerKernel({ now: fakeClock(NOW) });
  kernel.createPolicy(fundingFitV1());
  const store = new CorpusStore();
  store.putItem(fundingItem("cr_item_fundprog1", "program", "Seed Grant Program"));
  store.putItem(fundingItem("cr_item_fundinv1", "investor", "Early Stage Fund"));
  store.putItem(fundingItem("cr_item_fundprog2", "program", "Late Accelerator"));

  const score = (item_id: string, ds: DimensionScore[]) =>
    kernel.score({ item_id, policy_id: FUNDING_FIT_ID, policy_version: 1, dimension_scores: ds, scorer: { identity: "joe" }, source_blind: false });
  const sInv = score("cr_item_fundinv1", scores(5, 5, 4, 5)); // 19
  const sProg1 = score("cr_item_fundprog1", scores(5, 4, 3, 4)); // 16
  const sProg2 = score("cr_item_fundprog2", scores(3, 4, 5, 4)); // 16, loses the Fit tie-break

  const view = rank(kernel, store, {
    id: "cr_view_funding01",
    name: "funding-top",
    corpus_id: FUNDING_CORPUS_ID,
    policy_id: FUNDING_FIT_ID,
    policy_version: 1,
    query: { subject: "funding for corpus-ranker" },
    computed_at: NOW,
  });
  assert.deepEqual(contracts.registry.validate(view, schemaUri("ranked-view.schema.json")), []);
  assert.deepEqual(
    view.entries.map((e) => [e.item_id, e.rank, e.composite, e.score_event_ids]),
    [
      ["cr_item_fundinv1", 1, 19, [sInv.id]],
      ["cr_item_fundprog1", 2, 16, [sProg1.id]],
      ["cr_item_fundprog2", 3, 16, [sProg2.id]],
    ],
  );
  assert.deepEqual(view.entries.map((e) => store.item(e.item_id)!.item_type), ["investor", "program", "program"]);
});
