// CR-M2-T1 acceptance: the weekly papers JSONL importer loads records into
// Items and Originals, deduplicated on arXiv ID, with each record's provenance
// and capture hash preserved.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadContracts, schemaUri } from "../../src/contracts/index.ts";
import { CorpusStore, importPapersJsonl, normalizeArxivId } from "../../src/import/jsonl-importer.ts";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "papers-2026-W45.jsonl");
const fixture = readFileSync(fixturePath);
const lines = fixture.toString("utf8").split("\n");
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const CORPUS = "cr_corpus_papers01";
const NOW = "2026-11-10T00:00:00Z";
const options = {
  corpusId: CORPUS,
  source: "papers-2026-W45.jsonl",
  importedBy: "agent:import-jsonl",
  now: NOW,
  storageUriPrefix: "s3://ranker-originals/",
};

const contracts = loadContracts();

test("importer loads a JSONL fixture into Items and Originals, deduped on arXiv ID, provenance and capture hash preserved", () => {
  const store = new CorpusStore();
  const report = importPapersJsonl(fixture, store, options);

  // Every emitted object satisfies the frozen A2 contracts.
  for (const o of store.originals()) assert.deepEqual(contracts.registry.validate(o, schemaUri("original.schema.json")), [], o.id);
  for (const i of store.items()) assert.deepEqual(contracts.registry.validate(i, schemaUri("item.schema.json")), [], i.id);

  // Dedup on arXiv ID: four importable records name three papers.
  const items = store.items();
  assert.deepEqual(items.map((i) => i.identity_keys.arxiv_id).sort(), ["2611.01234", "2611.02345", "2611.03456"]);
  assert.equal(new Set(items.map((i) => i.id)).size, 3);

  // 2611.01234 arrived twice (plain and "arXiv:…v2"): one Item resting on both captures.
  const p1 = store.itemByArxivId("2611.01234")!;
  assert.equal(p1.title, "Context Management for Long-Horizon Agents", "first capture defines the Item");
  assert.equal(p1.original_ids.length, 2);
  const [first, second] = p1.original_ids.map((id) => store.original(id)!);
  assert.ok(first && second);

  // Capture hash: SHA-256 of the record's exact bytes, kept as content_hash and on the provenance.
  assert.equal(first.content_hash, sha256(lines[0]!));
  assert.equal(first.source.hash, first.content_hash);
  assert.equal(first.byte_size, Buffer.byteLength(lines[0]!));
  assert.equal(first.media_type, "application/json");
  assert.equal(first.storage_uri, `s3://ranker-originals/${first.content_hash}`);
  assert.equal(second.content_hash, sha256(lines[3]!));

  // Provenance: each record's own capture provenance survives, not the importer's.
  assert.deepEqual(first.source, {
    source_kind: "feed",
    source: "https://export.arxiv.org/rss/cs.AI",
    recorded_by: "agent:intake-arxiv",
    at: "2026-11-03T08:00:00Z",
    hash: sha256(lines[0]!),
  });
  assert.deepEqual(second.source, {
    source_kind: "url",
    source: "https://arxiv.org/abs/2611.01234v2",
    recorded_by: "joe",
    at: "2026-11-05T12:30:00Z",
    hash: sha256(lines[3]!),
  });
  // Raw record kept verbatim as source-native metadata.
  assert.deepEqual(second.raw_metadata, JSON.parse(lines[3]!));

  // 2611.02345 was captured twice with identical bytes: one Original, one Item.
  const p2 = store.itemByArxivId("2611.02345")!;
  assert.equal(p2.original_ids.length, 1);
  assert.equal(store.original(p2.original_ids[0]!)!.content_hash, sha256(lines[1]!));
  assert.equal(p2.identity_keys.doi, "10.48550/arXiv.2611.02345");
  assert.equal(p2.identity_keys.url, "https://arxiv.org/abs/2611.02345");

  // A record without its own provenance falls back to the import's (source file, importer, time).
  const p3 = store.itemByArxivId("2611.03456")!;
  const o3 = store.original(p3.original_ids[0]!)!;
  assert.deepEqual(o3.source, {
    source_kind: "upload",
    source: "papers-2026-W45.jsonl",
    recorded_by: "agent:import-jsonl",
    at: NOW,
    hash: sha256(lines[5]!),
  });

  assert.equal(store.originals().length, 4);
  assert.deepEqual(report, {
    records: 7,
    itemsCreated: 3,
    originalsCreated: 4,
    duplicateRecords: 2,
    errors: [
      { line: 7, message: "record has no arXiv ID" },
      { line: 8, message: report.errors[1]?.message ?? "" },
    ],
  });
  assert.match(report.errors[1]!.message, /invalid JSON/);
});

test("re-importing the same file is idempotent", () => {
  const store = new CorpusStore();
  importPapersJsonl(fixture, store, options);
  const before = JSON.stringify([store.items(), store.originals()]);
  const again = importPapersJsonl(fixture, store, { ...options, now: "2026-11-17T00:00:00Z" });
  assert.equal(again.itemsCreated, 0);
  assert.equal(again.originalsCreated, 0);
  assert.equal(JSON.stringify([store.items(), store.originals()]), before);
});

test("arXiv IDs are normalised before dedup", () => {
  assert.equal(normalizeArxivId("2611.01234"), "2611.01234");
  assert.equal(normalizeArxivId("arXiv:2611.01234v3"), "2611.01234");
  assert.equal(normalizeArxivId("https://arxiv.org/abs/2611.01234v2"), "2611.01234");
  assert.equal(normalizeArxivId("https://arxiv.org/pdf/2611.01234.pdf"), "2611.01234");
  assert.equal(normalizeArxivId("cs/0112017v1"), "cs/0112017");
  assert.equal(normalizeArxivId("not an id"), undefined);
});

test("a record whose own provenance is malformed is reported, not silently re-attributed", () => {
  const store = new CorpusStore();
  const bad = JSON.stringify({ arxiv_id: "2611.09999", title: "T", provenance: { source_kind: "carrier-pigeon", source: "x", recorded_by: "joe", at: NOW } });
  const report = importPapersJsonl(`${bad}\n`, store, options);
  assert.equal(report.errors.length, 1);
  assert.match(report.errors[0]!.message, /invalid provenance/);
  assert.equal(store.items().length, 0);
  assert.equal(store.originals().length, 0);
});
