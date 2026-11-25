// CR-SIG-SCHEMA acceptance: migration 0003 adds the signals schema beside the
// corpus with signals.trend_observation, one row per (term, geo, first_seen).
// A repeat sighting goes through signals.upsert_trend_observation, which moves
// last_seen forward instead of inserting another row. Trend observations are
// discovery signals (SPEC buzz rule), never quality scores. The service's
// grant role ranker_app records and reads them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { freshDatabase } from "./fresh-db.ts";

const APP = "ranker_app";

const sighting = (traffic: string, lastSeen: string, news: string) => `
  select signals.upsert_trend_observation(
    'google_trends', 'quantum error correction', 'US', '${traffic}',
    '2026-11-24T08:00:00Z', '${lastSeen}',
    '${news}'::jsonb
  )`;

const row = (db: { psqlAs(role: string, sql: string): string }) =>
  db.psqlAs(APP, `
    select count(*) || '|' || max(traffic) || '|' || to_char(max(last_seen) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS')
           || '|' || max(jsonb_array_length(news_items))
    from signals.trend_observation
    where term = 'quantum error correction' and geo = 'US'`);

test("a repeat sighting of the same term, geo and first_seen updates last_seen and inserts no row", { timeout: 600_000 }, async (t) => {
  const db = await freshDatabase(t);

  const news = '[{"title":"QEC milestone","url":"https://example.org/qec","source":"Example News"}]';
  const firstId = db.psqlAs(APP, sighting("200+", "2026-11-24T08:00:00Z", "[]"));
  assert.match(firstId, /^\d+$/);
  assert.equal(row(db), "1|200+|2026-11-24T08:00:00|0");

  // Repeat sighting: same key, later last_seen, the feed's current traffic label and news.
  const againId = db.psqlAs(APP, sighting("2,000+", "2026-11-24T12:30:00Z", news));
  assert.equal(againId, firstId, "the repeat sighting returns the existing row");
  assert.equal(row(db), "1|2,000+|2026-11-24T12:30:00|1");

  // A stale, out-of-order sighting never moves last_seen backwards.
  db.psqlAs(APP, sighting("100+", "2026-11-24T09:00:00Z", "[]"));
  assert.equal(row(db), "1|2,000+|2026-11-24T12:30:00|1");

  // A different first_seen or geo is a new observation.
  db.psqlAs(APP, `select signals.upsert_trend_observation('google_trends', 'quantum error correction', 'GB', '50+',
                    '2026-11-24T08:00:00Z', '2026-11-24T08:00:00Z', '[]'::jsonb)`);
  db.psqlAs(APP, `select signals.upsert_trend_observation('google_trends', 'quantum error correction', 'US', '500+',
                    '2026-11-25T08:00:00Z', '2026-11-25T08:00:00Z', '[]'::jsonb)`);
  assert.equal(db.psqlAs(APP, "select count(*) from signals.trend_observation"), "3");

  // The table itself enforces the key and its shape.
  assert.throws(
    () => db.psql(`insert into signals.trend_observation (signal_class, term, geo, traffic, first_seen, last_seen)
                     values ('google_trends', 'quantum error correction', 'US', '1+',
                             '2026-11-24T08:00:00Z', '2026-11-24T08:00:00Z')`),
    /duplicate key/,
  );
  assert.throws(() => db.psqlAs(APP, `select signals.upsert_trend_observation('google_trends', 'x', 'US', '1+',
                    '2026-11-24T08:00:00Z', '2026-11-23T08:00:00Z', '[]'::jsonb)`), /check constraint/);
  assert.throws(() => db.psqlAs(APP, `select signals.upsert_trend_observation('google_trends', 'x', 'US', '1+',
                    '2026-11-24T08:00:00Z', '2026-11-24T08:00:00Z', '{}'::jsonb)`), /check constraint/);

  // Discovery signals are kept, not deleted, by the service.
  assert.throws(() => db.psqlAs(APP, "delete from signals.trend_observation"), /permission denied/);
});
