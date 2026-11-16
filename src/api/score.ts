// SPEC A3 `score` over the frozen REST contract (contracts/openapi.json,
// operationId score): one Score event is appended to the ranker database
// under the Policy version it cites. The cited version must exist; the score
// is checked against that version by the kernel's rules (dimensions, scales,
// allowed scorers). Score events are append-only: scoring an Item again is a
// new event, and a correction is a retraction, never an update.
import { randomUUID } from "node:crypto";
import { loadContracts, openapiUri, type SchemaRegistry } from "../contracts/index.ts";
import { literal, type Sql } from "../db/psql.ts";
import { checkScore, KernelError, type Policy, type ScoreInput } from "../kernel/index.ts";
import type { ApiResponse } from "./capture.ts";

export interface ScoreDeps {
  sql: Sql;
  now: () => Date;
  /** Score event id generator (default: cr_score_ + random UUID hex). */
  newId?: () => string;
}

let registry: SchemaRegistry | undefined;
const contracts = () => (registry ??= loadContracts().registry);

const SCORE_REQUEST = () => `${openapiUri()}#/components/schemas/ScoreRequest`;
const error = (status: number, code: string, message: string): ApiResponse => ({ status, body: { error: code, message } });
const newScoreId = () => `cr_score_${randomUUID().replaceAll("-", "")}`;

type CitedPolicy = Pick<Policy, "id" | "version" | "dimensions" | "judge_config">;

/** Handle POST /v1/scores with an already-read request body. */
export async function score(rawBody: string, deps: ScoreDeps): Promise<ApiResponse> {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    return error(400, "invalid_json", `request body is not JSON: ${(e as Error).message}`);
  }
  const problems = contracts()
    .validate(body, SCORE_REQUEST())
    .map((e) => `${e.instancePath || "/"} ${e.message}`);
  if (problems.length > 0) return error(400, "invalid_request", problems.join("; "));
  const req = body as ScoreInput;

  const p = literal(req.policy_id);
  const found = JSON.parse(
    await deps.sql(`select json_build_object(
        'policy', (select json_build_object('id', id, 'version', version, 'dimensions', dimensions, 'judge_config', judge_config)
                     from policies where id = ${p} and version = ${req.policy_version}),
        'policy_exists', exists (select 1 from policies where id = ${p}),
        'item_exists', exists (select 1 from items where id = ${literal(req.item_id)}))`),
  ) as { policy: CitedPolicy | null; policy_exists: boolean; item_exists: boolean };

  if (found.policy === null) {
    return found.policy_exists
      ? error(404, "policy_version_not_found", `policy ${req.policy_id} has no version ${req.policy_version}`)
      : error(404, "policy_not_found", `policy ${req.policy_id} does not exist`);
  }
  if (!found.item_exists) return error(404, "item_not_found", `no item ${req.item_id}`);

  let checked: ScoreInput;
  try {
    checked = checkScore(found.policy, req, contracts());
  } catch (e) {
    if (!(e instanceof KernelError)) throw e;
    return error(e.code === "scorer_not_allowed" ? 403 : 400, e.code, e.message);
  }

  // The insert cites the policy version by foreign key, so a version that
  // does not exist can never be stored even if the check above were skipped.
  const id = (deps.newId ?? newScoreId)();
  const out = await deps.sql(`SET standard_conforming_strings = on;
    insert into score_events (id, item_id, policy_id, policy_version, dimension_scores, scorer, scored_at, source_blind)
    values (${literal(id)}, ${literal(checked.item_id)}, ${p}, ${checked.policy_version},
            ${literal(JSON.stringify(checked.dimension_scores))}::jsonb, ${literal(JSON.stringify(checked.scorer))}::jsonb,
            ${literal(deps.now().toISOString())}::timestamptz, ${checked.source_blind ? "true" : "false"})
    returning id;`);
  if (out !== id) throw new Error(`score event ${id} was not recorded (got ${JSON.stringify(out)})`);
  return { status: 201, body: { score_event_id: id } };
}
