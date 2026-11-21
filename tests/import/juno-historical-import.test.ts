import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { pgClient } from "../../src/db/client.ts";
import { DAILY_FILE, importHistoricalExport, publishedPaperRubricV1, readHistoricalExport } from "../../src/import/juno-historical-import.ts";
import { WEEKLY_FILES } from "../../src/import/corpus-import-job.ts";
import { freshDatabase } from "../schema/fresh-db.ts";
import { score as scoreHandler } from "../../src/api/score.ts";

function exportDirectory() {
  const dir = mkdtempSync(join(tmpdir(), "juno-historical-test-"));
  const paper = { arxiv_id: "2610.01234", title: "Research paper", first_seen: "2026-10-05", relevance: 5, technical_merit: 4 };
  const checksums = WEEKLY_FILES.map((file, index) => {
    const data = index === 0 ? JSON.stringify(paper) + "\n" : "";
    writeFileSync(join(dir, file), data);
    return `${createHash("sha256").update(data).digest("hex")}  ${file}\n`;
  });
  writeFileSync(join(dir, "SHA256SUMS"), checksums.join(""));
  return dir;
}

test("historical score preflight preserves rubric values and marks missing provenance", (t) => {
  const dir = exportDirectory();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { records, events } = readHistoricalExport(dir);
  assert.equal(records, 1);
  assert.equal(events[0]?.scorer.identity, "unknown");
  assert.equal(events[0]?.scorer.config?.scored_at_provenance, "unknown");
  assert.equal(events[0]?.scored_at, "2026-10-05T00:00:00Z");
  assert.deepEqual(events[0]?.dimension_scores.map(({ value }) => value), [5, 4]);
});

test("Juno backfill initializes an empty papers corpus and is safe to rerun", async (t) => {
  const dir = exportDirectory();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = await freshDatabase(t);
  const db = pgClient(fixture.databaseUrl());
  t.after(() => db.end());
  const blobs = new Map<string, Buffer>();
  const store = {
    async put(key: string, data: Buffer) { blobs.set(key, data); },
    async get(key: string) { return blobs.get(key) ?? null; },
    uri(key: string) { return `test:${key}`; },
    async ping() {},
  };
  const expected = { records: 1, originals: 1, items: 1, scores: 1 };
  assert.deepEqual(await importHistoricalExport(dir, db, store), expected);
  assert.deepEqual(await importHistoricalExport(dir, db, store), expected);
  assert.equal(blobs.size, 1);
  assert.equal(fixture.psql("select count(*) from item_originals"), "1");
  assert.equal(fixture.psql("select count(*) from score_events where scorer->>'identity' = 'unknown'"), "1");
  const transition = JSON.stringify({
    arxiv_id: "2610.01234", title: "Research paper, published", first_seen: "2026-10-06",
    relevance: 5, technical_merit: 4, version: "v2", published: true,
    journal_ref: "Example journal", supersedes: "2610.01234v1",
    scorer: { identity: "program:paper-judge", model: "test-fixture-model" },
    scored_at: "2026-10-06T04:00:00Z",
  }) + "\n";
  writeFileSync(join(dir, DAILY_FILE), transition);
  writeFileSync(join(dir, "SHA256SUMS"), `${createHash("sha256").update(transition).digest("hex")}  ${DAILY_FILE}\n`);
  assert.deepEqual(await importHistoricalExport(dir, db, store, true), expected);
  assert.deepEqual(await importHistoricalExport(dir, db, store, true), expected);
  assert.equal(fixture.psql("select count(*) from items where corpus_id='cr_corpus_papers'"), "2");
  assert.equal(fixture.psql("select count(*) from edges where edge_type='supersedes'"), "1");
});

test("daily mode requires recorded judge provenance before any production write", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ranker-daily-batch-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const legacy = { arxiv_id: "2610.01234", title: "Applied research", first_seen: "2026-10-05", relevance: 5, technical_merit: 4 };
  function write(record: unknown) {
    const line = JSON.stringify(record) + "\n";
    writeFileSync(join(dir, DAILY_FILE), line);
    writeFileSync(join(dir, "SHA256SUMS"), `${createHash("sha256").update(line).digest("hex")}  ${DAILY_FILE}\n`);
  }
  write(legacy);
  assert.throws(() => readHistoricalExport(dir, [DAILY_FILE], true), /paper judge identity, model and a valid scoring timestamp/);
  write({
    ...legacy,
    scorer: { identity: "program:paper-judge", model: "test-fixture-model" },
    scored_at: "2026-10-05T04:00:00Z",
  });
  const { events } = readHistoricalExport(dir, [DAILY_FILE], true);
  assert.equal(events[0]?.scorer.model, "test-fixture-model");
  assert.equal(events[0]?.scorer.config?.scored_at_provenance, "recorded");
  assert.deepEqual(events[0]?.dimension_scores.map(({ value }) => value), [5, 4]);
});

test("daily publication transitions retain their own item alongside the preprint", (t) => {
  const dir = exportDirectory();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const score = {
    arxiv_id: "2610.01234", title: "Applied research", first_seen: "2026-10-05",
    relevance: 5, technical_merit: 4, scored_at: "2026-10-05T04:00:00Z",
    scorer: { identity: "program:paper-judge", model: "test-fixture-model" },
  };
  const data = [
    { ...score, version: "v1" },
    { ...score, version: "v2", published: true, journal_ref: "Example journal", supersedes: "2610.01234v1" },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
  writeFileSync(join(dir, DAILY_FILE), data);
  writeFileSync(join(dir, "SHA256SUMS"), `${createHash("sha256").update(data).digest("hex")}  ${DAILY_FILE}\n`);
  const { corpus, events } = readHistoricalExport(dir, [DAILY_FILE], true);
  assert.equal(corpus.items().length, 2);
  const preprint = corpus.itemByArxivId(score.arxiv_id);
  const publication = corpus.items().find((item) => item.identity_keys.publication_version === "v2");
  assert.ok(preprint && publication);
  assert.notEqual(preprint.id, publication.id);
  assert.equal(publication.canonical_fields.supersedes, "2610.01234v1");
  assert.equal(new Set(events.map((e) => e.item_id)).size, 2);
});

test("a score by juno:weekly-aggregation-triage under the published paper-rubric v1 is recorded, not refused as scorer_not_allowed", async (t) => {
  const dir = exportDirectory();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = await freshDatabase(t);
  const db = pgClient(fixture.databaseUrl());
  t.after(() => db.end());
  const store = { async put() {}, async get() { return null; }, uri(key: string) { return `test:${key}`; }, async ping() {} };
  // The history import publishes paper-rubric v1 into the store.
  await importHistoricalExport(dir, db, store);
  const itemId = fixture.psql("select id from items where corpus_id='cr_corpus_papers' limit 1");
  const originalId = fixture.psql(`select original_id from item_originals where item_id='${itemId}'`);
  const out = await scoreHandler(JSON.stringify({
    item_id: itemId,
    policy_id: publishedPaperRubricV1.id,
    policy_version: publishedPaperRubricV1.version,
    dimension_scores: ["Relevance", "Technical Merit"].map((dimension, i) => ({
      dimension, value: 4 - i, reason: "Juno weekly triage score", evidence: [{ id: originalId }],
    })),
    scorer: { identity: "juno:weekly-aggregation-triage", config: { rubric: "paper-rubric v1", scored_at_from: "first_seen" } },
    source_blind: false,
    scored_at: "2026-11-04T00:00:00Z",
  }), { db, now: () => new Date("2026-11-20T12:00:00Z") });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  assert.equal(
    fixture.psql("select count(*) from score_events where scorer->>'identity' = 'juno:weekly-aggregation-triage' and policy_id='cr_pol_paper' and policy_version=1"),
    "1",
  );
});

test("the policy check mode reports a stored paper-rubric v1 without juno:weekly-aggregation-triage as differing, reports a matching or absent policy as admissible, and writes no row", async (t) => {
  const fixture = await freshDatabase(t);
  const cli = fileURLToPath(new URL("../../src/import/juno-historical-import.ts", import.meta.url));
  // Only RANKER_DATABASE_URL: no import directory, no object-store settings.
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", RANKER_DATABASE_URL: fixture.databaseUrl() };
  function check() {
    const run = spawnSync(process.execPath, [cli, "--check-policy"], { env, encoding: "utf8" });
    const lines = run.stdout.trim().split("\n");
    assert.equal(lines.length, 1, run.stdout + run.stderr);
    return { code: run.status, report: JSON.parse(lines[0]!) as Record<string, unknown> };
  }
  const snapshot = () => fixture.psql(
    "select count(*), coalesce(string_agg(md5(p::text), ',' order by id, version), '') from policies p",
  ) + "|" + fixture.psql("select count(*) from corpora");

  const empty = snapshot();
  assert.deepEqual(check(), {
    code: 0, report: { policy_id: "cr_pol_paper", policy_version: 1, status: "absent" },
  });
  assert.equal(snapshot(), empty);

  const p = publishedPaperRubricV1;
  fixture.psql(`insert into corpora (id,name,description,taxonomy_id,status)
    values ('cr_corpus_papers','papers','Applied AI research papers','cr_tax_papers','active')`);
  const withoutTriage = {
    ...p.judge_config,
    allowed_scorers: p.judge_config.allowed_scorers.filter((s) => s.identity !== "juno:weekly-aggregation-triage"),
  };
  const lit = (v: unknown) => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;
  fixture.psql(`insert into policies (id,version,name,corpus_id,dimensions,judge_config,composite_rule,created_by,created_at)
    values ('${p.id}',${p.version},'${p.name}','${p.corpus_id}',${lit(p.dimensions)},${lit(withoutTriage)},
      ${lit(p.composite_rule)},'${p.created_by}','${p.created_at}')`);
  const stale = snapshot();
  assert.deepEqual(check(), {
    code: 1,
    report: {
      policy_id: "cr_pol_paper", policy_version: 1, status: "differing",
      differing_fields: ["judge_config"],
      missing_allowed_scorers: [{ kind: "program", identity: "juno:weekly-aggregation-triage" }],
    },
  });
  assert.equal(snapshot(), stale);

  fixture.psql(`update policies set judge_config = ${lit(p.judge_config)} where id='${p.id}' and version=${p.version}`);
  const current = snapshot();
  assert.deepEqual(check(), {
    code: 0, report: { policy_id: "cr_pol_paper", policy_version: 1, status: "matching" },
  });
  assert.equal(snapshot(), current);
});
