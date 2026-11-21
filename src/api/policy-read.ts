// SPEC A3 `get_policy` over the frozen REST contract (contracts/openapi.json,
// operationId get_policy): one stored Policy version, read from the ranker
// database, returned as plain data in its SPEC A2.6 shape — dimensions,
// judge_config (allowed_scorers, source_blind) and composite_rule exactly as
// stored. Never built from seed code: what the database holds is the answer.
import type { Queryable } from "../db/client.ts";
import type { Policy } from "../kernel/index.ts";
import type { ApiResponse } from "./capture.ts";

export interface PolicyReadDeps {
  /** The ranker database, as the app role. */
  db: Queryable;
}

const POLICY_ID = /^cr_pol_[A-Za-z0-9]+$/;
const VERSION = /^[1-9][0-9]*$/;
// policies.version is a Postgres integer (db/migrations/0001_corpus_model.sql), so no stored
// version can exceed this; a larger, contract-valid version is simply not found.
const MAX_STORED_VERSION = 2_147_483_647;
const error = (status: number, code: string, message: string): ApiResponse => ({ status, body: { error: code, message } });

/** Handle GET /v1/policies/{policy_id}/versions/{version} with already-decoded path parameters. */
export async function getPolicy(policyId: string, rawVersion: string, deps: PolicyReadDeps): Promise<ApiResponse> {
  if (!POLICY_ID.test(policyId)) return error(400, "invalid_request", "policy_id is not a policy id (cr_pol_...)");
  if (!VERSION.test(rawVersion)) return error(400, "invalid_request", "version is not a positive integer");
  if (rawVersion.length > 10 || Number(rawVersion) > MAX_STORED_VERSION) {
    return error(404, "policy_not_found", `policy ${policyId} has no version ${rawVersion}`);
  }
  const version = Number(rawVersion);

  const [row] = await deps.db.query<{ policy: Policy }>(
    `select json_build_object(
        'id', id, 'name', name, 'corpus_id', corpus_id, 'version', version,
        'dimensions', dimensions, 'judge_config', judge_config, 'composite_rule', composite_rule,
        'created_by', created_by,
        'created_at', to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'supersedes_version', supersedes_version) as policy
       from policies where id = $1 and version = $2`,
    [policyId, version],
  );
  if (!row) return error(404, "policy_not_found", `policy ${policyId} has no version ${version}`);
  return { status: 200, body: row.policy };
}
