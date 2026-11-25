// CR-E2E-JOURNEY acceptance: a read-only API journey against a running
// ranker. `npm run test:e2e` runs it (CR-DEPLOY-QUEUE once per deploy batch,
// and the builder against the local replica with the shipped image); `npm
// test`, the fast pull-request job, never does (tests/ci/e2e-excluded.test.ts).
//
// It names its target through the environment and fails, rather than skips,
// when any of these is missing:
//   RANKER_BASE_URL     the ranker's base URL (e.g. http://127.0.0.1:8080)
//   RANKER_API_KEY      one principal's API key (Authorization: Bearer <key>)
//   RANKER_E2E_VIEW_ID  a saved Ranked View in that ranker (cr_view_...)
//
// The journey writes nothing: the corpus's items and Score events are
// append-only, so test data could never be taken back out. Every request goes
// through `read`, which refuses any request but a GET or the saved-view form
// of POST /v1/top-n ({ view_id }); the other Top-N form derives and saves a new
// Ranked View, so it is never sent. The view names its policy and version, so
// a ranker with one saved view is enough to read both.
//
// Each response is validated against the response schema contracts/openapi.json
// declares for that operation and status, not against a copy of it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadContracts, openapiUri } from "../../src/contracts/index.ts";

const contracts = loadContracts();
const REQUEST_TIMEOUT_MS = 15_000;

const openapi = contracts.openapi as { paths: Record<string, Record<string, { responses: Record<string, { $ref?: string }> }>> };
const escape = (s: string) => s.replace(/~/g, "~0").replace(/\//g, "~1");

/** The JSON pointer of one operation's response body schema in contracts/openapi.json (following a shared response's $ref). */
function responseSchema(path: string, method: string, status: number): string {
  const response = openapi.paths[path]?.[method]?.responses[String(status)];
  assert.ok(response, `contracts/openapi.json declares no ${status} response for ${method} ${path}`);
  const at = response.$ref?.startsWith("#/") ? response.$ref.slice(1) : `/paths/${escape(path)}/${method}/responses/${status}`;
  return `${openapiUri()}#${at}/content/application~1json/schema`;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} must be set: the journey runs against a ranker named by RANKER_BASE_URL, with RANKER_API_KEY and RANKER_E2E_VIEW_ID`);
  return value;
}

interface Reply {
  status: number;
  contentType: string | null;
  body: any;
}

/** The read-only client: a GET, or POST /v1/top-n by saved view id; any other request is refused before it is sent. */
async function read(base: string, method: "GET" | "POST", path: string, opts: { key?: string; body?: Record<string, unknown> } = {}): Promise<Reply> {
  const savedViewRead = method === "POST" && path === "/v1/top-n" && opts.body !== undefined && Object.keys(opts.body).join() === "view_id";
  if (method !== "GET" && !savedViewRead) throw new Error(`the journey is read-only; refusing ${method} ${path}`);
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.key !== undefined) headers.authorization = `Bearer ${opts.key}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(new URL(path, base), {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "error",
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    assert.fail(`${method} ${path} answered ${res.status} with a body that is not JSON: ${text.slice(0, 200)}`);
  }
  return { status: res.status, contentType: res.headers.get("content-type"), body };
}

function assertContractValid(reply: Reply, path: string, method: string, label: string) {
  assert.match(reply.contentType ?? "", /^application\/json\b/, `${label}: content type`);
  const problems = contracts.registry
    .validate(reply.body, responseSchema(path, method, reply.status))
    .map((e) => `${e.instancePath || "/"} ${e.message}`);
  assert.deepEqual(problems, [], `${label}: the ${reply.status} body is valid against contracts/openapi.json`);
}

test("an authenticated reader gets a ready ranker with a contract-valid policy and Top-N view", async () => {
  const base = required("RANKER_BASE_URL");
  const key = required("RANKER_API_KEY");
  const viewId = required("RANKER_E2E_VIEW_ID");

  // 1. The ranker is ready: its database and object store both answer.
  const ready = await read(base, "GET", "/readyz");
  assert.equal(ready.status, 200, `/readyz: ${JSON.stringify(ready.body)}`);
  assert.equal(ready.body.status, "ready", `/readyz: ${JSON.stringify(ready.body)}`);

  // 2. The saved view's Top-N, by id (the form that writes nothing).
  const topN = await read(base, "POST", "/v1/top-n", { key, body: { view_id: viewId } });
  assert.equal(topN.status, 200, `get_top_n ${viewId}: ${JSON.stringify(topN.body)}`);
  assertContractValid(topN, "/v1/top-n", "post", "get_top_n");
  assert.equal(topN.body.view_id, viewId);

  // 3. The policy version that view ranks by, read with the API key.
  const policyPath = `/v1/policies/${encodeURIComponent(topN.body.policy_id)}/versions/${topN.body.policy_version}`;
  const policy = await read(base, "GET", policyPath, { key });
  assert.equal(policy.status, 200, `get_policy ${policyPath}: ${JSON.stringify(policy.body)}`);
  assertContractValid(policy, "/v1/policies/{policy_id}/versions/{version}", "get", "get_policy");
  assert.equal(policy.body.id, topN.body.policy_id, "the policy read is the one the view ranks by");
  assert.equal(policy.body.version, topN.body.policy_version, "the policy version read is the one the view ranks by");
  // The view's per-dimension values are the policy's dimensions.
  const dimensions = new Set((policy.body.dimensions as { name: string }[]).map((d) => d.name));
  for (const entry of topN.body.entries as { item_id: string; dimension_values: Record<string, number> }[]) {
    for (const name of Object.keys(entry.dimension_values)) assert.ok(dimensions.has(name), `${entry.item_id}: dimension ${name} is in the policy`);
  }

  // 4. The key is what authorises the policy read: the same read without it is refused.
  const anonymous = await read(base, "GET", policyPath);
  assert.equal(anonymous.status, 401, `get_policy without a key: ${JSON.stringify(anonymous.body)}`);
  assertContractValid(anonymous, "/v1/policies/{policy_id}/versions/{version}", "get", "get_policy without a key");
});
