// CR-M3-T2 acceptance: POST /v1/scores appends a Score event (dimension
// scores, reasons, scorer identity) to the ranker database under the Policy
// version it cites and returns its event id. A score citing a Policy version
// that does not exist is refused and nothing is stored. Scores are
// append-only: two scores of one Item under one version both persist.
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { loadContracts, openapiUri } from "../../src/contracts/index.ts";
import { paperRubricV1 } from "../../src/import/paper-rubric.ts";
import { createServer, loadConfig } from "../../src/server.ts";
import { freshDatabase, type FreshDb } from "../schema/fresh-db.ts";
import { removePsqlFromPath } from "../db/no-psql.ts";

const CORPUS = "cr_corpus_papers01";
const ITEM = "cr_item_p0001";
const NOW = "2026-11-16T09:00:00.000Z";
const SERVICE = { user: "ranker_svc", password: "svc-local-only" };
const contracts = loadContracts();
const ERROR = `${openapiUri()}#/components/schemas/Error`;
const RESPONSE = `${openapiUri()}#/components/schemas/ScoreResponse`;

let db: FreshDb;
let base: string;
const cleanups: (() => unknown)[] = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

before(
  async () => {
    db = await freshDatabase({ after: (fn: () => unknown) => void cleanups.push(fn) } as unknown as TestContext);
    const policy = paperRubricV1({ corpusId: CORPUS, createdBy: "joe", createdAt: "2026-11-01T00:00:00Z" });
    db.psql(`
      insert into corpora (id, name, description, taxonomy_id, status)
        values ('${CORPUS}', 'papers', 'AI papers', 'cr_tax_papers1', 'active');
      insert into items (id, corpus_id, item_type, title)
        values ('${ITEM}', '${CORPUS}', 'paper', 'A paper');
      insert into policies (id, version, name, corpus_id, dimensions, judge_config, composite_rule, created_by)
        values ('${policy.id}', 1, '${policy.name}', '${CORPUS}', '${JSON.stringify(policy.dimensions).replace(/'/g, "''")}',
                '${JSON.stringify(policy.judge_config)}', '${JSON.stringify(policy.composite_rule)}', 'joe');
    `);
    // The service's login holds the app role, as deployment grants it (CR-D1).
    db.psql(`CREATE ROLE ${SERVICE.user} LOGIN PASSWORD '${SERVICE.password}' IN ROLE ranker_app`);
    // The service image has no psql; neither does this test process.
    removePsqlFromPath();
    // The service runs as the app role through its default in-process
    // database client; prove the role's grants suffice.
    const server = createServer(loadConfig({ RANKER_DATABASE_URL: db.databaseUrl(SERVICE) }), { now: () => new Date(NOW) });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    cleanups.push(() => new Promise((ok) => server.close(ok)));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  },
  { timeout: 600_000 },
);

function score(body: unknown): Promise<Response> {
  return fetch(`${base}/v1/scores`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function request(extra: Record<string, unknown> = {}) {
  return {
    item_id: ITEM,
    policy_id: "cr_pol_paper",
    policy_version: 1,
    dimension_scores: [
      { dimension: "Relevance", value: 5, reason: "Directly addresses agent context management.", evidence: [] },
      { dimension: "Technical Merit", value: 4, reason: "Careful ablations; code released.", evidence: [] },
    ],
    scorer: { identity: "program:paper-judge", model: "claude-opus-5-5" },
    source_blind: true,
    ...extra,
  };
}

const countScores = () => Number(db.psql("select count(*) from score_events"));

test("a score under a cited policy version is appended and returns its event id", async () => {
  const before = countScores();
  const res = await score(request());
  assert.equal(res.status, 201);
  const body = (await res.json()) as { score_event_id: string };
  assert.deepEqual(contracts.registry.validate(body, RESPONSE), []);

  const row = JSON.parse(
    db.psql(`select json_build_object('item_id', item_id, 'policy_id', policy_id, 'policy_version', policy_version,
               'dimension_scores', dimension_scores, 'scorer', scorer, 'source_blind', source_blind,
               'scored_at', to_char(scored_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
             from score_events where id = '${body.score_event_id}'`),
  );
  assert.deepEqual(row, { ...request(), scored_at: NOW });
  assert.equal(countScores(), before + 1);

  // Append-only: a second score of the same Item under the same version is its own event.
  const again = await score(request({ dimension_scores: [{ dimension: "Relevance", value: 3, reason: "On reflection, tangential.", evidence: [] }] }));
  assert.equal(again.status, 201);
  const second = (await again.json()) as { score_event_id: string };
  assert.notEqual(second.score_event_id, body.score_event_id);
  assert.equal(
    db.psql(`select count(*) from score_events where item_id = '${ITEM}' and policy_id = 'cr_pol_paper' and policy_version = 1`),
    String(before + 2),
  );
});

test("a score citing an unknown policy version is refused", async () => {
  const before = countScores();
  for (const [name, body] of [
    ["unknown version", request({ policy_version: 2 })],
    ["unknown policy", request({ policy_id: "cr_pol_nosuch" })],
  ] as const) {
    const res = await score(body);
    assert.equal(res.status, 404, name);
    assert.deepEqual(contracts.registry.validate(await res.json(), ERROR), [], name);
  }
  assert.equal(countScores(), before, "nothing was stored");
});

test("a score that breaks the contract or its policy version is refused", async () => {
  const before = countScores();
  const cases: [string, unknown, number][] = [
    ["invalid JSON", "{nope", 400],
    ["missing reason", request({ dimension_scores: [{ dimension: "Relevance", value: 5, evidence: [] }] }), 400],
    ["no policy version", { ...request(), policy_version: undefined }, 400],
    ["dimension not in policy", request({ dimension_scores: [{ dimension: "Vibes", value: 5, reason: "r", evidence: [] }] }), 400],
    ["value off scale", request({ dimension_scores: [{ dimension: "Relevance", value: 9, reason: "r", evidence: [] }] }), 400],
    ["scorer not allowed", request({ scorer: { identity: "agent:intake-arxiv" } }), 403],
    ["unknown item", request({ item_id: "cr_item_missing" }), 404],
  ];
  for (const [name, body, status] of cases) {
    const res = await score(body);
    assert.equal(res.status, status, name);
    assert.deepEqual(contracts.registry.validate(await res.json(), ERROR), [], name);
  }
  assert.equal(countScores(), before, "nothing was stored");
});

test("a score made earlier keeps its own scored_at; a future one is refused", async () => {
  const before = countScores();
  for (const [given, stored] of [
    ["2026-10-01T00:00:00Z", "2026-10-01T00:00:00.000Z"],
    ["2026-10-07T11:15:00+02:00", "2026-10-07T09:15:00.000Z"],
  ] as const) {
    const res = await score(request({ scored_at: given }));
    assert.equal(res.status, 201, given);
    const { score_event_id } = (await res.json()) as { score_event_id: string };
    assert.equal(
      db.psql(`select to_char(scored_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from score_events where id = '${score_event_id}'`),
      stored,
      "the given date is stored, not the time of recording",
    );
  }
  assert.equal(countScores(), before + 2);

  for (const [name, body] of [
    ["in the future", request({ scored_at: "2026-11-17T00:00:00Z" })],
    ["not a date-time", request({ scored_at: "2026-10-01" })],
  ] as const) {
    const res = await score(body);
    assert.equal(res.status, 400, name);
    assert.deepEqual(contracts.registry.validate(await res.json(), ERROR), [], name);
  }
  assert.equal(countScores(), before + 2, "nothing more was stored");
});
