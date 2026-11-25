-- 0003 signals: trend observations, stored beside the corpus in their own
-- schema of the ranker database (placement decided in CRANK-353).
--
-- A trend observation is a discovery signal (SPEC buzz rule): a term seen
-- trending in a geo, with the feed's traffic label kept verbatim (e.g.
-- "2,000+") and the news items the feed attached. It is never a quality score
-- and nothing here feeds scoring. One row per (term, geo, first_seen); a
-- repeat sighting goes through signals.upsert_trend_observation, which moves
-- last_seen forward and refreshes the label and news instead of adding a row.
-- Shape: contracts/schemas/v1/trend-observation.schema.json.

CREATE SCHEMA signals;
REVOKE ALL ON SCHEMA signals FROM PUBLIC;

CREATE TABLE signals.trend_observation (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  signal_class text NOT NULL CHECK (signal_class ~ '^[a-z][a-z0-9_]*$'),
  term         text NOT NULL CHECK (length(term) > 0),
  geo          text NOT NULL CHECK (length(geo) > 0),
  traffic      text NOT NULL,
  first_seen   timestamptz NOT NULL,
  last_seen    timestamptz NOT NULL,
  news_items   jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(news_items) = 'array'),
  CONSTRAINT trend_observation_seen_order CHECK (last_seen >= first_seen),
  CONSTRAINT trend_observation_sighting UNIQUE (term, geo, first_seen)
);

-- Record a sighting. A repeat of (term, geo, first_seen) updates the existing
-- row: last_seen only moves forward, and the traffic label and news items are
-- taken from the newest sighting. Returns the row's id.
CREATE FUNCTION signals.upsert_trend_observation(
  p_signal_class text, p_term text, p_geo text, p_traffic text,
  p_first_seen timestamptz, p_last_seen timestamptz, p_news_items jsonb
) RETURNS bigint
LANGUAGE sql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $fn$
  INSERT INTO signals.trend_observation AS t
    (signal_class, term, geo, traffic, first_seen, last_seen, news_items)
  VALUES (p_signal_class, p_term, p_geo, p_traffic, p_first_seen, p_last_seen, p_news_items)
  ON CONFLICT ON CONSTRAINT trend_observation_sighting DO UPDATE SET
    last_seen  = greatest(t.last_seen, excluded.last_seen),
    traffic    = CASE WHEN excluded.last_seen >= t.last_seen THEN excluded.traffic ELSE t.traffic END,
    news_items = CASE WHEN excluded.last_seen >= t.last_seen THEN excluded.news_items ELSE t.news_items END
  RETURNING t.id;
$fn$;
REVOKE ALL ON FUNCTION signals.upsert_trend_observation(text, text, text, text, timestamptz, timestamptz, jsonb) FROM PUBLIC;

-- The service records and reads sightings; it never deletes them.
GRANT USAGE ON SCHEMA signals TO ranker_app;
GRANT SELECT, INSERT, UPDATE ON signals.trend_observation TO ranker_app;
GRANT EXECUTE ON FUNCTION signals.upsert_trend_observation(text, text, text, text, timestamptz, timestamptz, jsonb)
  TO ranker_app;

INSERT INTO schema_migrations (version, name) VALUES (3, 'signals_trend_observation');
