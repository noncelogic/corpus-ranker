// SPEC A3 `get_top_n` over the frozen REST contract (contracts/openapi.json,
// operationId get_top_n): the ordered top entries of a Ranked View, each with
// its item summary, composite and per-dimension values.
//
// Two request forms:
// - { view_id }: the entries of a saved Ranked View, as saved.
// - { corpus_id, policy_name, query, n }: a new Ranked View is derived from the
//   stored Score events under the named Policy's latest version (the same
//   ordering as `rank`), saved, and its top N entries returned.
//
// The Top-N is a derived view: scoring is not ranking, so this never writes or
// changes a Score event; the only rows it writes are the saved view's.
import { randomUUID } from "node:crypto";
import { loadContracts, openapiUri, type SchemaRegistry } from "../contracts/index.ts";
import { literal, type Sql } from "../db/psql.ts";
import { KernelError, type DimensionScore, type Policy, type ScoreEvent } from "../kernel/index.ts";
import { rankScores } from "../rank/ranked-view.ts";
import type { ApiResponse } from "./capture.ts";

export interface TopNDeps {
  sql: Sql;
  now: () => Date;
  /** Ranked View id generator (default: cr_view_ + random UUID hex). */
  newViewId?: () => string;
}

/** One entry of the contract's TopN response. */
export interface TopNEntry {
  item_id: string;
  rank: number;
  title: string;
  summary: string | null;
  composite: number;
  dimension_values: Record<string, number>;
}

/** The contract's TopN response. */
export interface TopN {
  view_id: string;
  policy_id: string;
  policy_version: number;
  stale: boolean;
  stale_reason: string | null;
  entries: TopNEntry[];
}

type TopNRequest =
  | { view_id: string }
  | { corpus_id: string; policy_name: string; query: { subject?: string; filters?: unknown; vector_query?: string }; n: number };

let registry: SchemaRegistry | undefined;
const contracts = () => (registry ??= loadContracts().registry);

const TOP_N_REQUEST = () => `${openapiUri()}#/components/schemas/GetTopNRequest`;
const error = (status: number, code: string, message: string): ApiResponse => ({ status, body: { error: code, message } });
const newViewId = () => `cr_view_${randomUUID().replaceAll("-", "")}`;
const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

const dimensionValues = (scores: readonly DimensionScore[]) => Object.fromEntries(scores.map((d) => [d.dimension, d.value]));

/** Handle POST /v1/top-n with an already-read request body. */
export async function topN(rawBody: string, deps: TopNDeps): Promise<ApiResponse> {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    return error(400, "invalid_json", `request body is not JSON: ${(e as Error).message}`);
  }
  const problems = contracts()
    .validate(body, TOP_N_REQUEST())
    .map((e) => `${e.instancePath || "/"} ${e.message}`);
  if (problems.length > 0) return error(400, "invalid_request", problems.join("; "));
  const req = body as TopNRequest;
  return "view_id" in req ? savedView(req.view_id, deps.sql) : derivedView(req, deps);
}

/** The entries of a saved Ranked View, with the dimension values of the Score events each entry cites. */
async function savedView(viewId: string, sql: Sql): Promise<ApiResponse> {
  const v = literal(viewId);
  const found = JSON.parse(
    await sql(`select json_build_object(
        'view', (select json_build_object('policy_id', policy_id, 'policy_version', policy_version,
                                          'stale', stale, 'stale_reason', stale_reason)
                   from ranked_views where id = ${v}),
        'entries', coalesce((
          select json_agg(json_build_object(
                   'item_id', e.item_id, 'rank', e.rank, 'title', i.title, 'summary', i.summary, 'composite', e.composite,
                   'dimension_scores', (select coalesce(json_agg(d order by s.scored_at, s.id), '[]')
                                          from score_events s, jsonb_array_elements(s.dimension_scores) d
                                         where s.id = any (e.score_event_ids)))
                 order by e.rank)
            from ranked_view_entries e join items i on i.id = e.item_id
           where e.view_id = ${v}), '[]'))`),
  ) as {
    view: Omit<TopN, "view_id" | "entries"> | null;
    entries: (Omit<TopNEntry, "dimension_values"> & { dimension_scores: DimensionScore[] })[];
  };
  if (found.view === null) return error(404, "view_not_found", `no ranked view ${viewId}`);
  const out: TopN = {
    view_id: viewId,
    ...found.view,
    entries: found.entries.map(({ dimension_scores, ...e }) => ({ ...e, dimension_values: dimensionValues(dimension_scores) })),
  };
  return { status: 200, body: out };
}

/** Derives, saves and returns a new Ranked View under the named Policy's latest version. */
async function derivedView(req: Extract<TopNRequest, { policy_name: string }>, deps: TopNDeps): Promise<ApiResponse> {
  // `rank` applies the subject only; filters and vector queries are not
  // implemented yet, so they are refused rather than silently ignored.
  const unsupported = Object.keys(req.query).filter((k) => k !== "subject");
  if (unsupported.length > 0 || req.query.subject === undefined) {
    return error(400, "unsupported_query", `only a subject query is supported (got ${Object.keys(req.query).join(", ")})`);
  }

  const c = literal(req.corpus_id);
  const policies = JSON.parse(
    await deps.sql(`select json_build_object(
        'corpus_exists', exists (select 1 from corpora where id = ${c}),
        'policies', coalesce((
          select json_agg(json_build_object(
                   'id', p.id, 'version', p.version, 'name', p.name, 'corpus_id', p.corpus_id, 'dimensions', p.dimensions,
                   'judge_config', p.judge_config, 'composite_rule', p.composite_rule, 'created_by', p.created_by,
                   'created_at', to_char(p.created_at at time zone 'UTC', ${ISO}), 'supersedes_version', p.supersedes_version)
                 order by p.id)
            from policies p
           where p.corpus_id = ${c} and p.name = ${literal(req.policy_name)}
             and p.version = (select max(q.version) from policies q where q.id = p.id)), '[]'))`),
  ) as { corpus_exists: boolean; policies: Policy[] };
  if (!policies.corpus_exists) return error(404, "corpus_not_found", `no corpus ${req.corpus_id}`);
  if (policies.policies.length === 0) {
    return error(404, "policy_not_found", `corpus ${req.corpus_id} has no policy named ${req.policy_name}`);
  }
  if (policies.policies.length > 1) {
    const ids = policies.policies.map((p) => p.id).join(", ");
    return error(400, "ambiguous_policy_name", `policy name ${req.policy_name} names more than one policy in ${req.corpus_id}: ${ids}`);
  }
  const policy = policies.policies[0]!;

  // The version's live Score events of active items in the corpus, in
  // recording order (what `rank` expects), with those items' title and summary.
  const p = literal(policy.id);
  const stored = JSON.parse(
    await deps.sql(`select json_build_object(
        'scores', coalesce((
          select json_agg(json_build_object(
                   'id', s.id, 'item_id', s.item_id, 'policy_id', s.policy_id, 'policy_version', s.policy_version,
                   'dimension_scores', s.dimension_scores, 'scorer', s.scorer, 'source_blind', s.source_blind,
                   'scored_at', to_char(s.scored_at at time zone 'UTC', ${ISO}),
                   'retracted_at', null, 'retracted_by', null, 'retraction_reason', null)
                 order by s.recorded_at, s.id)
            from score_events s join items i on i.id = s.item_id
           where s.policy_id = ${p} and s.policy_version = ${policy.version}
             and i.corpus_id = ${c} and i.status = 'active'
             and not exists (select 1 from score_retractions r where r.score_event_id = s.id)), '[]'),
        'items', coalesce((
          select json_object_agg(i.id, json_build_object('title', i.title, 'summary', i.summary))
            from items i
           where i.corpus_id = ${c} and i.status = 'active'
             and exists (select 1 from score_events s where s.item_id = i.id and s.policy_id = ${p}
                           and s.policy_version = ${policy.version})), '{}'))`),
  ) as { scores: ScoreEvent[]; items: Record<string, { title: string; summary: string | null }> };

  let ranked;
  try {
    ranked = rankScores(policy, stored.scores, (itemId) => itemId in stored.items, { corpus_id: req.corpus_id, n: req.n });
  } catch (e) {
    if (!(e instanceof KernelError)) throw e;
    return error(400, e.code, e.message);
  }

  // Save the Ranked View (it is reproducible from the Score events it cites).
  const viewId = (deps.newViewId ?? newViewId)();
  const v = literal(viewId);
  const entryRows = ranked.map(
    (e) =>
      `(${v}, ${e.rank}, ${literal(e.item_id)}, ${e.composite}, array[${e.score_event_ids.map(literal).join(", ")}]::text[])`,
  );
  const out = await deps.sql(`SET standard_conforming_strings = on;
    begin;
    insert into ranked_views (id, name, corpus_id, policy_id, policy_version, query, computed_at)
    values (${v}, ${literal(`top-n-${req.policy_name}`)}, ${c}, ${p}, ${policy.version},
            ${literal(JSON.stringify({ subject: req.query.subject }))}::jsonb, ${literal(deps.now().toISOString())}::timestamptz);
    ${entryRows.length > 0 ? `insert into ranked_view_entries (view_id, rank, item_id, composite, score_event_ids) values ${entryRows.join(",\n      ")};` : ""}
    commit;
    select id from ranked_views where id = ${v};`);
  if (out !== viewId) throw new Error(`ranked view ${viewId} was not recorded (got ${JSON.stringify(out)})`);

  const result: TopN = {
    view_id: viewId,
    policy_id: policy.id,
    policy_version: policy.version,
    stale: false,
    stale_reason: null,
    entries: ranked.map((e) => ({
      item_id: e.item_id,
      rank: e.rank,
      title: stored.items[e.item_id]!.title,
      summary: stored.items[e.item_id]!.summary,
      composite: e.composite,
      dimension_values: dimensionValues(e.score.dimension_scores),
    })),
  };
  return { status: 200, body: result };
}
