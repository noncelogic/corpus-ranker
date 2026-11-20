// SPEC A3 `score` over the frozen REST contract (contracts/openapi.json,
// operationId score): one Score event is appended to the ranker database
// under the Policy version it cites. The cited version must exist; the score
// is checked against that version by the kernel's rules (dimensions, scales,
// allowed scorers). Score events are append-only: scoring an Item again is a
// new event, and a correction is a retraction, never an update.
// A score made before it is recorded here (SPEC A7 Phase 0 import) carries
// its own `scored_at`, which is stored as given; it may not lie in the
// future. Without one, the score is dated when it is recorded.
import { randomUUID } from "node:crypto";
import { loadContracts, openapiUri, type SchemaRegistry } from "../contracts/index.ts";
import type { Queryable } from "../db/client.ts";
import { checkScore, KernelError, type Policy, type ScoreInput } from "../kernel/index.ts";
import type { ApiResponse } from "./capture.ts";

export interface ScoreDeps {
  /** The ranker database, as the app role. */
  db: Queryable;
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
  const req = body as ScoreInput & { scored_at?: string };
  const recordedAt = deps.now();
  if (req.scored_at !== undefined && Date.parse(req.scored_at) > recordedAt.getTime()) {
    return error(400, "invalid_request", `/scored_at ${req.scored_at} is in the future`);
  }

  // $1 policy id, $2 policy version, $3 item id.
  const [row] = await deps.db.query<{ found: { policy: CitedPolicy | null; policy_exists: boolean; item_exists: boolean } }>(
    `select json_build_object(
        'policy', (select json_build_object('id', id, 'version', version, 'dimensions', dimensions, 'judge_config', judge_config)
                     from policies where id = $1 and version = $2),
        'policy_exists', exists (select 1 from policies where id = $1),
        'item_exists', exists (select 1 from items where id = $3)) as found`,
    [req.policy_id, req.policy_version, req.item_id],
  );
  const found = row!.found;

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
  const [inserted] = await deps.db.query<{ id: string }>(
    `insert into score_events (id, item_id, policy_id, policy_version, dimension_scores, scorer, scored_at, source_blind)
     values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::timestamptz, $8)
     returning id`,
    [
      id,
      checked.item_id,
      req.policy_id,
      checked.policy_version,
      JSON.stringify(checked.dimension_scores),
      JSON.stringify(checked.scorer),
      req.scored_at ?? recordedAt.toISOString(),
      checked.source_blind,
    ],
  );
  const out = inserted?.id;
  if (out !== id) throw new Error(`score event ${id} was not recorded (got ${JSON.stringify(out)})`);
  return { status: 201, body: { score_event_id: id } };
}
