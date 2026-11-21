import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { pgClient } from "../../src/db/client.ts";
import { importHistoricalExport, publishedPaperRubricV1 } from "../../src/import/juno-historical-import.ts";
import { WEEKLY_FILES } from "../../src/import/corpus-import-job.ts";
import { freshDatabase, type FreshDb } from "../schema/fresh-db.ts";

const scorer = "juno:weekly-aggregation-triage";
const p = publishedPaperRubricV1;
const cli = fileURLToPath(new URL("../../src/import/juno-historical-import.ts", import.meta.url));

function exportDirectory() {
  const dir = mkdtempSync(join(tmpdir(), "juno-preflight-test-"));
  const paper = { arxiv_id: "2610.01234", title: "Research paper", first_seen: "2026-10-05", relevance: 5, technical_merit: 4 };
  const checksums = WEEKLY_FILES.map((file, index) => {
    const data = index === 0 ? JSON.stringify(paper) + "\n" : "";
    writeFileSync(join(dir, file), data);
    return `${createHash("sha256").update(data).digest("hex")}  ${file}\n`;
  });
  writeFileSync(join(dir, "SHA256SUMS"), checksums.join(""));
  return dir;
}

function recordingStore() {
  const puts: string[] = [];
  return {
    puts,
    async put(key: string) { puts.push(key); },
    async get() { return null; },
    uri(key: string) { return `test:${key}`; },
    async ping() {},
  };
}

const lit = (v: unknown) => `'${JSON.stringify(v).replaceAll("'", "''")}'::jsonb`;

function storePolicy(fixture: FreshDb, allowedScorers: typeof p.judge_config.allowed_scorers) {
  fixture.psql(`insert into corpora (id,name,description,taxonomy_id,status)
    values ('cr_corpus_papers','papers','Applied AI research papers','cr_tax_papers','active')`);
  fixture.psql(`insert into policies (id,version,name,corpus_id,dimensions,judge_config,composite_rule,created_by,created_at)
    values ('${p.id}',${p.version},'${p.name}','${p.corpus_id}',${lit(p.dimensions)},
      ${lit({ ...p.judge_config, allowed_scorers: allowedScorers })},
      ${lit(p.composite_rule)},'${p.created_by}','${p.created_at}')`);
}

const snapshot = (fixture: FreshDb) => fixture.psql(
  "select count(*), coalesce(string_agg(md5(p::text), ',' order by id, version), '') from policies p",
) + "|" + ["corpora", "originals", "items", "item_originals", "edges", "score_events"]
  .map((table) => fixture.psql(`select count(*) from ${table}`)).join(",");

test("refuses before any capture when the stored policy version does not admit the import scorer", async (t) => {
  const dir = exportDirectory();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = await freshDatabase(t);
  storePolicy(fixture, p.judge_config.allowed_scorers.filter((s) => s.identity !== scorer));
  const before = snapshot(fixture);

  const db = pgClient(fixture.databaseUrl());
  t.after(() => db.end());
  const store = recordingStore();
  await assert.rejects(importHistoricalExport(dir, db, store), (error: Error) => {
    assert.equal(error.name, "ImportPolicyDeniedError");
    assert.match(error.message, /cr_pol_paper/);
    assert.match(error.message, /version 1\b/);
    assert.match(error.message, /juno:weekly-aggregation-triage/);
    return true;
  });
  assert.deepEqual(store.puts, [], "no original is captured to the object store");
  assert.equal(snapshot(fixture), before, "no row is written and the stored version is unchanged");

  // The Job entry point exits non-zero and names the policy id, version and scorer.
  // The S3 endpoint is unreachable: the refusal must come before any capture.
  const run = spawnSync(process.execPath, [cli], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "", RANKER_IMPORT_DIR: dir, RANKER_DATABASE_URL: fixture.databaseUrl(),
      RANKER_S3_ENDPOINT: "http://127.0.0.1:9", RANKER_S3_BUCKET: "unused",
      RANKER_S3_ACCESS_KEY_ID: "unused", RANKER_S3_SECRET_ACCESS_KEY: "unused",
    },
  });
  assert.notEqual(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stderr, /cr_pol_paper/);
  assert.match(run.stderr, /version 1\b/);
  assert.match(run.stderr, /juno:weekly-aggregation-triage/);
  assert.equal(run.stdout.trim(), "");
  assert.equal(snapshot(fixture), before);
});

test("imports when the stored policy version admits the import scorer", async (t) => {
  const dir = exportDirectory();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fixture = await freshDatabase(t);
  storePolicy(fixture, p.judge_config.allowed_scorers);
  const db = pgClient(fixture.databaseUrl());
  t.after(() => db.end());
  const store = recordingStore();
  assert.deepEqual(await importHistoricalExport(dir, db, store), { records: 1, originals: 1, items: 1, scores: 1 });
  assert.equal(store.puts.length, 1);
  assert.equal(fixture.psql("select count(*) from score_events where policy_id='cr_pol_paper' and policy_version=1"), "1");
});
