import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pgClient } from "../../src/db/client.ts";
import { importHistoricalExport, readHistoricalExport } from "../../src/import/juno-historical-import.ts";
import { WEEKLY_FILES } from "../../src/import/corpus-import-job.ts";
import { freshDatabase } from "../schema/fresh-db.ts";

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
  };
  const expected = { records: 1, originals: 1, items: 1, scores: 1 };
  assert.deepEqual(await importHistoricalExport(dir, db, store), expected);
  assert.deepEqual(await importHistoricalExport(dir, db, store), expected);
  assert.equal(blobs.size, 1);
  assert.equal(fixture.psql("select count(*) from item_originals"), "1");
  assert.equal(fixture.psql("select count(*) from score_events where scorer->>'identity' = 'unknown'"), "1");
});
