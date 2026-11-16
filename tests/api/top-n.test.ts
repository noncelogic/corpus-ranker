// CR-M3-T3 acceptance: POST /v1/top-n returns the N highest-composite items of
// a corpus under a named Policy, from a Ranked View over the stored Score
// events, each entry with its composite and per-dimension values. The Top-N is
// a derived view: it never writes a Score event.
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadContracts, openapiUri } from "../../src/contracts/index.ts";
import { CorpusStore, importPapersJsonl } from "../../src/import/jsonl-importer.ts";
import { compareLeaderboards, jsonlLeaderboard, rankedLeaderboard, viewLeaderboard } from "../../src/import/leaderboard.ts";
import { PAPER_RUBRIC_ID, PAPER_RUBRIC_NAME, paperRubricV1 } from "../../src/import/paper-rubric.ts";
import { importScoresJsonl } from "../../src/import/score-import.ts";
import { RankerKernel, type Policy } from "../../src/kernel/index.ts";
import { rank } from "../../src/rank/ranked-view.ts";
import { createServer, loadConfig } from "../../src/server.ts";
import { fakeClock } from "../kernel/fixtures.ts";
import { freshDatabase, type FreshDb } from "../schema/fresh-db.ts";
import { removePsqlFromPath } from "../db/no-psql.ts";

const here = dirname(fileURLToPath(import.meta.url));
const NOW = "2026-11-16T09:00:00.000Z";
const SERVICE = { user: "ranker_svc", password: "svc-local-only" };
const PAPERS = "cr_corpus_papers01";
const TOY = "cr_corpus_toy01";
const contracts = loadContracts();
const TOP_N = `${openapiUri()}#/components/schemas/TopN`;
const ERROR = `${openapiUri()}#/components/schemas/Error`;

let db: FreshDb;
let base: string;
const cleanups: (() => unknown)[] = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

const q = (v: unknown) => `'${(typeof v === "string" ? v : JSON.stringify(v)).replace(/'/g, "''")}'`;
const insertPolicy = (p: Policy) =>
  `insert into policies (id, version, name, corpus_id, dimensions, judge_config, composite_rule, created_by, supersedes_version)
     values (${q(p.id)}, ${p.version}, ${q(p.name)}, ${q(p.corpus_id)}, ${q(p.dimensions)}, ${q(p.judge_config)},
             ${q(p.composite_rule)}, ${q(p.created_by)}, ${p.supersedes_version ?? "null"});`;

// The Phase 0 fixture corpus, imported in memory the way the leaderboard check does it.
const fixtureFiles = ["papers-2026-W42.jsonl", "papers-2026-W43.jsonl"].map((name) => ({
  name,
  data: readFileSync(join(here, "..", "import", "fixtures", "leaderboard", name)),
}));
const store = new CorpusStore();
const kernel = new RankerKernel({ now: fakeClock(NOW) });
const paperPolicy = kernel.createPolicy(paperRubricV1({ corpusId: PAPERS, createdBy: "joe", createdAt: NOW }));
for (const f of fixtureFiles) {
  importPapersJsonl(f.data, store, { corpusId: PAPERS, importedBy: "agent:import-jsonl", now: NOW, storageUriPrefix: "s3://ranker-originals/", source: f.name });
}
for (const f of fixtureFiles) importScoresJsonl(f.data, store, kernel, { corpusId: PAPERS, source: f.name });

// A small hand-built corpus under a weighted policy with two versions.
const toyV1: Policy = {
  ...paperRubricV1({ corpusId: TOY, createdBy: "joe", createdAt: NOW }),
  id: "cr_pol_toy",
  name: "toy-rubric",
  dimensions: paperRubricV1({ corpusId: TOY, createdBy: "joe", createdAt: NOW }).dimensions.map((d) => ({
    ...d,
    weight: d.name === "Relevance" ? 2 : 1,
  })),
};
const toyV2: Policy = { ...toyV1, version: 2, supersedes_version: 1 };

let seq = 0;
const scoreRow = (id: string, item: string, version: number, rel: number, tm: number, scoredAt: string) => {
  seq++;
  return `insert into score_events (id, item_id, policy_id, policy_version, dimension_scores, scorer, scored_at, source_blind, recorded_at)
    values ('${id}', '${item}', 'cr_pol_toy', ${version},
            ${q([{ dimension: "Relevance", value: rel, reason: "r", evidence: [] }, { dimension: "Technical Merit", value: tm, reason: "r", evidence: [] }])},
            '{"identity": "joe"}', '${scoredAt}', false, timestamptz '2026-11-01T00:00:00Z' + interval '${seq} seconds');`;
};

before(
  async () => {
    db = await freshDatabase({ after: (fn: () => unknown) => void cleanups.push(fn) } as unknown as TestContext);
    const items = store.items();
    const scores = kernel.liveScores({ policy_id: PAPER_RUBRIC_ID, policy_version: 1 });
    db.psql(`
      insert into corpora (id, name, description, taxonomy_id, status) values
        ('${PAPERS}', 'papers', 'AI papers', 'cr_tax_papers1', 'active'),
        ('${TOY}', 'toy', 'A toy corpus', 'cr_tax_toy1', 'active');
      ${insertPolicy(paperPolicy)}
      insert into items (id, corpus_id, item_type, title, summary, identity_keys, status) values
        ${items.map((i) => `(${q(i.id)}, ${q(i.corpus_id)}, ${q(i.item_type)}, ${q(i.title)}, ${i.summary === null ? "null" : q(i.summary)}, ${q(i.identity_keys)}, ${q(i.status)})`).join(",\n")};
      ${scores
        .map(
          (s, n) => `insert into score_events (id, item_id, policy_id, policy_version, dimension_scores, scorer, scored_at, source_blind, recorded_at)
            values (${q(s.id)}, ${q(s.item_id)}, ${q(s.policy_id)}, ${s.policy_version}, ${q(s.dimension_scores)}, ${q(s.scorer)},
                    ${q(s.scored_at)}, ${s.source_blind}, timestamptz '2026-11-01T00:00:00Z' + interval '${n} seconds');`,
        )
        .join("\n")}

      ${insertPolicy(toyV1)}
      ${insertPolicy(toyV2)}
      insert into items (id, corpus_id, item_type, title, summary, status) values
        ('cr_item_t1', '${TOY}', 'paper', 'Toy one', 'First.', 'active'),
        ('cr_item_t2', '${TOY}', 'paper', 'Toy two', null, 'active'),
        ('cr_item_t3', '${TOY}', 'paper', 'Toy three', 'Third.', 'active'),
        ('cr_item_t4', '${TOY}', 'paper', 'Toy four', 'Fourth.', 'active'),
        ('cr_item_t5', '${TOY}', 'paper', 'Toy five', 'Gone.', 'tombstoned'),
        ('cr_item_t6', '${TOY}', 'paper', 'Toy six', 'Retracted.', 'active');
      ${scoreRow("cr_score_t1a", "cr_item_t1", 2, 3, 5, "2026-10-01T00:00:00Z")}
      ${scoreRow("cr_score_t1b", "cr_item_t1", 2, 5, 2, "2026-10-02T00:00:00Z")}
      ${scoreRow("cr_score_t2", "cr_item_t2", 2, 4, 4, "2026-10-01T00:00:00Z")}
      ${scoreRow("cr_score_t3", "cr_item_t3", 2, 4, 3, "2026-10-01T00:00:00Z")}
      ${scoreRow("cr_score_t4", "cr_item_t4", 2, 1, 2, "2026-10-01T00:00:00Z")}
      ${scoreRow("cr_score_t4v1", "cr_item_t4", 1, 5, 5, "2026-10-03T00:00:00Z")}
      ${scoreRow("cr_score_t5", "cr_item_t5", 2, 5, 5, "2026-10-01T00:00:00Z")}
      ${scoreRow("cr_score_t6", "cr_item_t6", 2, 5, 5, "2026-10-01T00:00:00Z")}
      insert into score_retractions (score_event_id, retracted_by, retraction_reason)
        values ('cr_score_t6', 'joe', 'test: retracted scores do not rank');
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

async function topN(body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/v1/top-n`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const countScores = () => db.psql("select (select count(*) from score_events) || '/' || (select count(*) from score_retractions)");

test("the top-n returns the highest composites in order with per-dimension values", async () => {
  const scoresBefore = countScores();
  const res = await topN({ corpus_id: TOY, policy_name: "toy-rubric", query: { subject: "toy papers" }, n: 3 });
  assert.equal(res.status, 200);
  assert.deepEqual(contracts.registry.validate(res.body, TOP_N), []);

  // Under the latest version (v2), composite = 2·Relevance + Technical Merit. t1's
  // latest score (5,2) wins over its earlier (3,5); t1 and t2 tie at 12 and the
  // Relevance tie-break puts t1 first. The v1 score of t4, the tombstoned t5 and
  // the retracted t6 do not count; t4 (composite 4) falls below the top 3.
  assert.match(res.body.view_id, /^cr_view_[A-Za-z0-9]+$/);
  assert.deepEqual({ ...res.body, view_id: "x" }, {
    view_id: "x",
    policy_id: "cr_pol_toy",
    policy_version: 2,
    stale: false,
    stale_reason: null,
    entries: [
      { item_id: "cr_item_t1", rank: 1, title: "Toy one", summary: "First.", composite: 12, dimension_values: { Relevance: 5, "Technical Merit": 2 } },
      { item_id: "cr_item_t2", rank: 2, title: "Toy two", summary: null, composite: 12, dimension_values: { Relevance: 4, "Technical Merit": 4 } },
      { item_id: "cr_item_t3", rank: 3, title: "Toy three", summary: "Third.", composite: 11, dimension_values: { Relevance: 4, "Technical Merit": 3 } },
    ],
  });

  // It is served from a saved Ranked View citing the exact Score events used.
  assert.equal(
    db.psql(`select string_agg(item_id || ':' || composite || ':' || array_to_string(score_event_ids, ','), ' ' order by rank)
               from ranked_view_entries where view_id = '${res.body.view_id}'`),
    "cr_item_t1:12:cr_score_t1b cr_item_t2:12:cr_score_t2 cr_item_t3:11:cr_score_t3",
  );
  const saved = await topN({ view_id: res.body.view_id });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, res.body);

  // Scoring is not ranking: no Score event was written or retracted.
  assert.equal(countScores(), scoresBefore);
});

test("the top-n over the imported fixture corpus matches the reproduced leaderboard", async () => {
  const scoresBefore = countScores();
  const res = await topN({ corpus_id: PAPERS, policy_name: PAPER_RUBRIC_NAME, query: { subject: "all-time leaderboard" }, n: 100 });
  assert.equal(res.status, 200);
  assert.deepEqual(contracts.registry.validate(res.body, TOP_N), []);
  assert.equal(res.body.policy_id, PAPER_RUBRIC_ID);
  assert.equal(res.body.policy_version, 1);

  // The Top-N's own entries, reduced to the leaderboard shape, match the
  // JSONL-derived all-time leaderboard (incl. the papers at 5+5).
  const arxiv = (itemId: string) => store.item(itemId)!.identity_keys.arxiv_id!;
  const fromTopN = rankedLeaderboard(
    res.body.entries.map((e: { item_id: string; composite: number; dimension_values: Record<string, number> }) => ({
      arxiv_id: arxiv(e.item_id),
      composite: e.composite,
      scores: e.dimension_values,
    })),
  );
  const fromJsonl = jsonlLeaderboard(fixtureFiles.map((f) => f.data));
  const report = compareLeaderboards(fromJsonl, fromTopN);
  assert.deepEqual(report.mismatches, []);
  assert.equal(report.matches, true);
  assert.equal(fromTopN.counts.top, 3);

  // And it is exactly the in-memory Ranked View of the same corpus, entry for entry.
  const view = rank(kernel, store, {
    id: "cr_view_mem01",
    name: "all-time",
    corpus_id: PAPERS,
    policy_id: PAPER_RUBRIC_ID,
    policy_version: 1,
    query: { subject: "all-time leaderboard" },
    computed_at: NOW,
  });
  assert.deepEqual(
    res.body.entries.map((e: { item_id: string; rank: number; composite: number }) => [e.item_id, e.rank, e.composite]),
    view.entries.map((e) => [e.item_id, e.rank, e.composite]),
  );
  assert.deepEqual(compareLeaderboards(viewLeaderboard(view, kernel, store), fromTopN).mismatches, []);

  // N bounds the entries; the head is the same.
  const top2 = await topN({ corpus_id: PAPERS, policy_name: PAPER_RUBRIC_NAME, query: { subject: "all-time leaderboard" }, n: 2 });
  assert.deepEqual(top2.body.entries, res.body.entries.slice(0, 2));
  assert.equal(countScores(), scoresBefore);
});

test("a top-n request the service cannot answer is refused", async () => {
  const cases: [string, unknown, number][] = [
    ["invalid JSON", "{nope", 400],
    ["no n", { corpus_id: TOY, policy_name: "toy-rubric", query: { subject: "s" } }, 400],
    ["n below 1", { corpus_id: TOY, policy_name: "toy-rubric", query: { subject: "s" }, n: 0 }, 400],
    ["filters not supported", { corpus_id: TOY, policy_name: "toy-rubric", query: { subject: "s", vector_query: "v" }, n: 1 }, 400],
    ["unknown policy name", { corpus_id: TOY, policy_name: "no-such-rubric", query: { subject: "s" }, n: 1 }, 404],
    ["policy of another corpus", { corpus_id: TOY, policy_name: PAPER_RUBRIC_NAME, query: { subject: "s" }, n: 1 }, 404],
    ["unknown corpus", { corpus_id: "cr_corpus_nosuch", policy_name: "toy-rubric", query: { subject: "s" }, n: 1 }, 404],
    ["unknown view", { view_id: "cr_view_nosuch" }, 404],
  ];
  for (const [name, body, status] of cases) {
    const res = await topN(body);
    assert.equal(res.status, status, name);
    assert.deepEqual(contracts.registry.validate(res.body, ERROR), [], name);
  }
});
