// CR-M4-T2 acceptance: the tracker importer turns each row of a grants-tracker
// CSV export into one program Item resting on the row as its Original,
// deduplicated on the program URL (SPEC §A7 Phase 2). The fixture is
// synthetic: it carries the tracker's column headers, no real tracker rows.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadContracts, schemaUri } from "../../src/contracts/index.ts";
import { FUNDING_CORPUS_ID } from "../../src/funding/funding-fit.ts";
import { CorpusStore } from "../../src/import/jsonl-importer.ts";
import { importTrackerCsv, normalizeProgramUrl } from "../../src/import/tracker-importer.ts";

const fixture = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "grants-tracker.csv"));
const text = fixture.toString("utf8");
const physical = text.split("\n");
// Data rows as exact text (row 3 spans two physical lines inside a quoted cell).
const rows = {
  grant: physical[1]!,
  fellowship: physical[2]!,
  accelerator: `${physical[3]}\n${physical[4]}`,
  grant2027: physical[6]!,
};
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const NOW = "2026-11-16T00:00:00Z";
const options = {
  corpusId: FUNDING_CORPUS_ID,
  source: "grants-tracker.csv",
  importedBy: "agent:import-tracker",
  now: NOW,
  storageUriPrefix: "s3://ranker-originals/",
};
const contracts = loadContracts();

test("each tracker row becomes one program item resting on its row original", () => {
  const store = new CorpusStore();
  const report = importTrackerCsv(fixture, store, options);

  for (const o of store.originals()) assert.deepEqual(contracts.registry.validate(o, schemaUri("original.schema.json")), [], o.id);
  for (const i of store.items()) assert.deepEqual(contracts.registry.validate(i, schemaUri("item.schema.json")), [], i.id);

  const items = store.items();
  assert.equal(items.length, 3);
  assert.ok(items.every((i) => i.item_type === "program" && i.corpus_id === FUNDING_CORPUS_ID));

  // The row's exact bytes are the Original.
  const grant = store.itemByUrl("https://grants.example.org/open-research", FUNDING_CORPUS_ID)!;
  assert.equal(grant.title, "Example Open Research Grant");
  const grantOrig = store.original(grant.original_ids[0]!)!;
  assert.equal(grantOrig.content_hash, sha256(rows.grant));
  assert.equal(grantOrig.byte_size, Buffer.byteLength(rows.grant));
  assert.equal(grantOrig.media_type, "text/csv");
  assert.equal(grantOrig.storage_uri, `s3://ranker-originals/${sha256(rows.grant)}`);
  assert.deepEqual(grantOrig.source, {
    source_kind: "upload",
    source: "grants-tracker.csv",
    recorded_by: "agent:import-tracker",
    at: NOW,
    hash: sha256(rows.grant),
  });
  assert.equal(grantOrig.raw_metadata["Program URL"], "https://grants.example.org/open-research");
  assert.equal(grantOrig.raw_metadata.Amount, "$50,000");

  // Status, deadline and provenance columns become canonical fields.
  assert.deepEqual(grant.identity_keys, { url: "https://grants.example.org/open-research" });
  assert.deepEqual(grant.canonical_fields, {
    program_url: "https://grants.example.org/open-research",
    funder: "Example Foundation",
    status: "Researching",
    deadline: "2026-12-15",
    amount: "$50,000",
    provenance: { source: "https://grants.example.org/", added_by: "joe", added_at: "2026-11-02T09:00:00Z" },
  });

  // A row without a deadline is imported with the deadline empty.
  const fellowship = store.itemByUrl("https://fellowship.example.net/apply", FUNDING_CORPUS_ID)!;
  assert.equal(fellowship.canonical_fields.deadline, null);
  assert.equal(fellowship.canonical_fields.status, "Shortlisted");
  assert.equal(store.original(fellowship.original_ids[0]!)!.content_hash, sha256(rows.fellowship));

  // A quoted cell may hold commas and a newline; the whole record is one Original.
  const acc = store.itemByUrl("https://accelerator.example.com/cohort-3", FUNDING_CORPUS_ID)!;
  assert.equal(acc.title, "Placeholder Accelerator, Cohort 3");
  assert.equal(acc.canonical_fields.amount, "Up to $100,000\nplus mentoring");
  assert.equal(store.original(acc.original_ids[0]!)!.content_hash, sha256(rows.accelerator));

  assert.deepEqual(report, {
    records: 6,
    itemsCreated: 3,
    originalsCreated: 4,
    duplicateRecords: 2,
    errors: [{ line: 9, message: "row has no program URL" }],
  });
});

test("a second row with the same program URL captures onto the existing item", () => {
  const store = new CorpusStore();
  importTrackerCsv(fixture, store, options);

  // Same program URL (case and trailing slash aside): one Item, two Originals.
  const urls = store.items().map((i) => i.identity_keys.url);
  assert.equal(new Set(urls).size, urls.length, "two rows with the same program URL must not become two items");
  const grant = store.itemByUrl(normalizeProgramUrl("https://Grants.Example.org/open-research/")!, FUNDING_CORPUS_ID)!;
  assert.equal(grant.title, "Example Open Research Grant", "the first row defines the Item");
  assert.deepEqual(
    grant.original_ids.map((id) => store.original(id)!.content_hash),
    [sha256(rows.grant), sha256(rows.grant2027)],
  );
  assert.equal(grant.created_at, NOW);

  // Identical row bytes are the same Original: the fellowship rests on one.
  const fellowship = store.itemByUrl("https://fellowship.example.net/apply", FUNDING_CORPUS_ID)!;
  assert.equal(fellowship.original_ids.length, 1);

  // Re-importing the export is a no-op.
  const before = JSON.stringify([store.items(), store.originals()]);
  const again = importTrackerCsv(fixture, store, { ...options, now: "2026-11-23T00:00:00Z" });
  assert.equal(again.itemsCreated, 0);
  assert.equal(again.originalsCreated, 0);
  assert.equal(JSON.stringify([store.items(), store.originals()]), before);
});

test("program URLs are normalised before dedup", () => {
  assert.equal(normalizeProgramUrl("https://Grants.Example.org/open-research/"), "https://grants.example.org/open-research");
  assert.equal(normalizeProgramUrl(" https://grants.example.org/open-research#apply "), "https://grants.example.org/open-research");
  assert.equal(normalizeProgramUrl("https://example.org/"), "https://example.org/");
  assert.equal(normalizeProgramUrl("not a url"), undefined);
  assert.equal(normalizeProgramUrl("mailto:grants@example.org"), undefined);
});

test("a tracker export without the program URL column is rejected whole", () => {
  const store = new CorpusStore();
  const report = importTrackerCsv("Program,Status\nA,Open\n", store, options);
  assert.deepEqual(report.errors, [{ line: 1, message: "header has no Program URL column" }]);
  assert.equal(store.items().length, 0);
});
