// CR-M1-T3 acceptance: Score events are append-only for the app role
// (TECH-STACK §2: enforced by grants). Retraction is itself an appended
// event, never an edit of the score row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase } from "./fresh-db.ts";

const APP = "ranker_app";

test("app role cannot update or delete score events", { timeout: 600_000 }, async (t) => {
  const db = await freshDatabase(t);

  db.psql(`
    insert into corpora (id, name, description, taxonomy_id, status)
      values ('cr_corpus_papers', 'papers', '', 'cr_tax_papers1', 'active');
    insert into items (id, corpus_id, item_type, title, canonical_fields, identity_keys, status)
      values ('cr_item_p1', 'cr_corpus_papers', 'paper', 'Paper One', '{}', '{}', 'active');
    insert into policies (id, version, name, corpus_id, dimensions, judge_config, composite_rule, created_by)
      values ('cr_pol_rubric', 1, 'paper-rubric', 'cr_corpus_papers', '[{"name":"Relevance"}]',
              '{"allowed_scorers":[],"source_blind":false}', '{"method":"weighted_sum","tie_breaks":[]}', 'joe');
  `);

  // The app role can append and read score events.
  db.psqlAs(APP, `
    insert into score_events (id, item_id, policy_id, policy_version, dimension_scores, scorer, scored_at, source_blind)
      values ('cr_score_s1', 'cr_item_p1', 'cr_pol_rubric', 1,
              '[{"dimension":"Relevance","value":4,"reason":"why","evidence":[]}]',
              '{"identity":"joe"}', '2026-11-01T00:00:00Z', false);
  `);
  assert.equal(db.psqlAs(APP, "select count(*) from score_events"), "1");

  // ...but can never change or remove one.
  const denied = /permission denied/;
  assert.throws(() => db.psqlAs(APP, "update score_events set policy_version = 1 where id = 'cr_score_s1'"), denied);
  assert.throws(() => db.psqlAs(APP, "delete from score_events where id = 'cr_score_s1'"), denied);
  assert.throws(() => db.psqlAs(APP, "truncate score_events"), denied);

  // Retraction is an appended event recorded against the score; also append-only.
  db.psqlAs(APP, `
    insert into score_retractions (score_event_id, retracted_by, retraction_reason)
      values ('cr_score_s1', 'joe', 'judge misread the abstract');
  `);
  assert.throws(() => db.psqlAs(APP, "update score_retractions set retraction_reason = 'x'"), denied);
  assert.throws(() => db.psqlAs(APP, "delete from score_retractions"), denied);
  assert.throws(
    () => db.psqlAs(APP, `insert into score_retractions (score_event_id, retracted_by, retraction_reason)
                           values ('cr_score_s1', 'joe', 'again')`),
    /duplicate key/,
    "a score is retracted at most once",
  );
  assert.throws(
    () => db.psqlAs(APP, `insert into score_retractions (score_event_id, retracted_by, retraction_reason)
                           values ('cr_score_s1', 'joe', '')`),
  );

  // The score stays in history, marked retracted.
  assert.equal(
    db.psqlAs(APP, "select id || '|' || (retracted_at is not null) from score_events_with_retraction"),
    "cr_score_s1|true",
  );

  // Cited policy versions are immutable to the app role as well.
  assert.throws(() => db.psqlAs(APP, "update policies set name = 'x'"), denied);
  assert.throws(() => db.psqlAs(APP, "delete from policies"), denied);
});
