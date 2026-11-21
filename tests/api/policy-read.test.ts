// CR-M3-POLICY-READ acceptance: an authenticated GET of one policy id and
// version returns that stored Policy version as plain data in its SPEC A2.6
// shape (contracts/openapi.json operationId get_policy), including
// judge_config.allowed_scorers, read from the database rather than from seed
// code. An unknown id or version is the contract's not-found error; a request
// without a valid API key is refused before anything is read.
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { loadContracts, openapiUri } from "../../src/contracts/index.ts";
import type { Policy } from "../../src/kernel/index.ts";
import { paperRubricV1 } from "../../src/import/paper-rubric.ts";
import { createServer, loadConfig } from "../../src/server.ts";
import { freshDatabase, type FreshDb } from "../schema/fresh-db.ts";
import { removePsqlFromPath } from "../db/no-psql.ts";

const CORPUS = "cr_corpus_papers01";
const SERVICE = { user: "ranker_svc", password: "svc-local-only" };
const KEY = "joe-key-local-only";
const contracts = loadContracts();
const ERROR = `${openapiUri()}#/components/schemas/Error`;
const POLICY = `${openapiUri()}#/components/schemas/Policy`;

// Version 1 as the seed code builds it; version 2 written to the database
// only, with allowed scorers and a judge config the seed code does not know.
const v1: Policy = paperRubricV1({ corpusId: CORPUS, createdBy: "joe", createdAt: "2026-11-01T00:00:00.000Z" });
const v2: Policy = {
  ...v1,
  version: 2,
  judge_config: {
    allowed_scorers: [
      { kind: "human", identity: "joe" },
      { kind: "llm_judge", identity: "program:paper-judge-v2", config: { model: "gpt-5", temperature: 0 } },
      { kind: "program", identity: "agent:hermes" },
    ],
    source_blind: true,
  },
  created_at: "2026-11-10T12:30:00.000Z",
  supersedes_version: 1,
};

let db: FreshDb;
let base: string;
const cleanups: (() => unknown)[] = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

const lit = (v: unknown) => `'${JSON.stringify(v).replace(/'/g, "''")}'`;
const insert = (p: Policy) => `
  insert into policies (id, version, name, corpus_id, dimensions, judge_config, composite_rule, created_by, created_at, supersedes_version)
    values ('${p.id}', ${p.version}, '${p.name}', '${p.corpus_id}', ${lit(p.dimensions)}, ${lit(p.judge_config)},
            ${lit(p.composite_rule)}, '${p.created_by}', '${p.created_at}', ${p.supersedes_version ?? "null"});`;

before(
  async () => {
    db = await freshDatabase({ after: (fn: () => unknown) => void cleanups.push(fn) } as unknown as TestContext);
    db.psql(`
      insert into corpora (id, name, description, taxonomy_id, status)
        values ('${CORPUS}', 'papers', 'AI papers', 'cr_tax_papers1', 'active');
      ${insert(v1)}
      ${insert(v2)}
    `);
    db.psql(`CREATE ROLE ${SERVICE.user} LOGIN PASSWORD '${SERVICE.password}' IN ROLE ranker_app`);
    removePsqlFromPath();
    const config = { ...loadConfig({ RANKER_DATABASE_URL: db.databaseUrl(SERVICE) }), apiKeys: new Map([["joe", KEY]]) };
    const server = createServer(config);
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    cleanups.push(() => new Promise((ok) => server.close(ok)));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  },
  { timeout: 600_000 },
);

function getPolicy(id: string, version: string | number, headers: Record<string, string> = { authorization: `Bearer ${KEY}` }) {
  return fetch(`${base}/v1/policies/${id}/versions/${version}`, { headers });
}

test("returns the stored policy version with its judge_config allowed_scorers as written to the database", async () => {
  const res = await getPolicy(v2.id, 2);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Policy;
  assert.deepEqual(contracts.registry.validate(body, POLICY), []);
  assert.deepEqual(body, v2);
  assert.notDeepEqual(body.judge_config, v1.judge_config, "read from the database, not from seed code");

  // A change in the database is what the next read returns.
  const scorers = [{ kind: "human", identity: "joe" }];
  db.psql(`update policies set judge_config = ${lit({ allowed_scorers: scorers, source_blind: false })}
             where id = '${v2.id}' and version = 2`);
  const again = (await (await getPolicy(v2.id, 2)).json()) as Policy;
  assert.deepEqual(again.judge_config, { allowed_scorers: scorers, source_blind: false });

  const first = await getPolicy(v1.id, 1);
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), v1);
});

test("refuses an unknown policy id or version with the contract's not-found error", async () => {
  for (const [name, id, version] of [
    ["unknown version", v1.id, 3],
    ["unknown policy", "cr_pol_nosuch", 1],
    ["absent ten-digit version", v1.id, 1000000001],
    ["version beyond the stored integer range", v1.id, 2147483648],
    ["version far beyond the stored integer range", v1.id, "123456789012345678901234567890"],
  ] as const) {
    const res = await getPolicy(id, version);
    assert.equal(res.status, 404, name);
    const body = (await res.json()) as { error: string };
    assert.deepEqual(contracts.registry.validate(body, ERROR), [], name);
    assert.equal(body.error, "policy_not_found", name);
  }
  // A large version the contract and the database allow is read, not refused.
  const big: Policy = { ...v1, version: 1000000000 };
  db.psql(insert(big));
  const found = await getPolicy(v1.id, 1000000000);
  assert.equal(found.status, 200);
  assert.deepEqual(await found.json(), big);
  for (const [name, id, version] of [
    ["malformed id", "not-a-policy", 1],
    ["version zero", v1.id, 0],
    ["non-integer version", v1.id, "one"],
  ] as const) {
    const res = await getPolicy(id, version);
    assert.equal(res.status, 400, name);
    assert.deepEqual(contracts.registry.validate(await res.json(), ERROR), [], name);
  }
});

test("refuses a request without a valid API key", async () => {
  for (const [name, headers] of [
    ["no key", {}],
    ["wrong key", { authorization: "Bearer not-the-key" }],
    ["key without the bearer scheme", { authorization: KEY }],
    ["empty bearer", { authorization: "Bearer " }],
  ] as const) {
    for (const [id, version] of [[v1.id, 1], ["cr_pol_nosuch", 1]] as const) {
      const res = await getPolicy(id, version, headers);
      assert.equal(res.status, 401, `${name} ${id}`);
      const body = (await res.json()) as { error: string };
      assert.deepEqual(contracts.registry.validate(body, ERROR), [], name);
      assert.equal(body.error, "unauthenticated", name);
      assert.ok(!JSON.stringify(body).includes(KEY), "never echoes a key");
    }
  }
});
