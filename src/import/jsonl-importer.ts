// Weekly papers JSONL importer (SPEC §A7 Phase 0).
//
// Each non-blank line of a weekly papers file is one captured record. The
// record's exact bytes become an Original (content-addressed: the SHA-256 of
// the line is its capture hash), and the paper it describes becomes an Item,
// deduplicated on its normalised arXiv ID. A paper seen in several records
// (another week, a later version) gets one Item resting on every distinct
// capture; identical bytes captured twice are one Original (SPEC §A3 capture).
//
// Provenance: a record carrying its own `provenance` object (the shared SPEC §4
// shape) keeps it; otherwise the import itself is recorded as the source.
import { createHash } from "node:crypto";
import { loadContracts, schemaUri, type SchemaRegistry } from "../contracts/index.ts";

export type SourceKind = "url" | "feed" | "inbox" | "upload" | "api";

export interface Provenance {
  source_kind: SourceKind;
  source: string;
  recorded_by: string;
  at: string;
  hash?: string;
}

/** SPEC A2.2 Original, as defined by contracts/schemas/v1/original.schema.json. */
export interface Original {
  id: string;
  corpus_id: string;
  content_hash: string;
  media_type: string;
  byte_size: number;
  storage_uri: string;
  source: Provenance;
  raw_metadata: Record<string, unknown>;
  tombstoned_at: string | null;
  tombstone_reason: string | null;
}

/** SPEC A2.3 Item, as defined by contracts/schemas/v1/item.schema.json. */
export interface Item {
  id: string;
  corpus_id: string;
  item_type: string;
  title: string;
  summary: string | null;
  canonical_fields: Record<string, unknown>;
  original_ids: string[];
  identity_keys: Record<string, string>;
  status: "active" | "merged" | "superseded" | "tombstoned";
  created_at: string;
  updated_at: string;
}

/** In-memory Items and Originals, indexed for capture-hash and arXiv-ID dedup. */
export class CorpusStore {
  readonly #items = new Map<string, Item>();
  readonly #originals = new Map<string, Original>();
  readonly #byHash = new Map<string, string>();
  readonly #byArxiv = new Map<string, string>();

  items(): Item[] {
    return [...this.#items.values()];
  }

  originals(): Original[] {
    return [...this.#originals.values()];
  }

  item(id: string): Item | undefined {
    return this.#items.get(id);
  }

  original(id: string): Original | undefined {
    return this.#originals.get(id);
  }

  itemByArxivId(arxivId: string, corpusId?: string): Item | undefined {
    const id = normalizeArxivId(arxivId);
    if (id === undefined) return undefined;
    if (corpusId !== undefined) {
      const itemId = this.#byArxiv.get(`${corpusId}\0${id}`);
      return itemId === undefined ? undefined : this.#items.get(itemId);
    }
    return this.items().find((i) => i.identity_keys.arxiv_id === id);
  }

  originalByHash(corpusId: string, contentHash: string): Original | undefined {
    const id = this.#byHash.get(`${corpusId}\0${contentHash}`);
    return id === undefined ? undefined : this.#originals.get(id);
  }

  putOriginal(o: Original): void {
    this.#originals.set(o.id, o);
    this.#byHash.set(`${o.corpus_id}\0${o.content_hash}`, o.id);
  }

  putItem(i: Item): void {
    this.#items.set(i.id, i);
    const arxiv = i.identity_keys.arxiv_id;
    if (arxiv !== undefined) this.#byArxiv.set(`${i.corpus_id}\0${arxiv}`, i.id);
  }
}

export interface ImportOptions {
  corpusId: string;
  /** Name of the file being imported; the provenance source for records without their own. */
  source: string;
  /** Agent identity performing the import (SPEC §4), e.g. agent:import-jsonl. */
  importedBy: string;
  /** Import time (ISO 8601); also the capture time for records without their own provenance. */
  now: string;
  /** Content-addressed storage location prefix; the content hash is appended. */
  storageUriPrefix: string;
}

export interface ImportError {
  /** 1-based line number in the file. */
  line: number;
  message: string;
}

export interface ImportReport {
  /** Non-blank lines read. */
  records: number;
  itemsCreated: number;
  originalsCreated: number;
  /** Records whose arXiv ID matched an Item that already existed. */
  duplicateRecords: number;
  errors: ImportError[];
}

const NEW_STYLE = /^(\d{4}\.\d{4,5})(v\d+)?$/;
const OLD_STYLE = /^([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?$/;

/**
 * Canonical arXiv ID without version: accepts bare IDs, `arXiv:` prefixes and
 * arxiv.org abs/pdf URLs. Returns undefined if no arXiv ID can be read.
 */
export function normalizeArxivId(raw: string): string | undefined {
  let s = raw.trim();
  const url = /^https?:\/\/(?:export\.|www\.)?arxiv\.org\/(?:abs|pdf)\/(.+?)(?:\.pdf)?\/?$/i.exec(s);
  if (url) s = url[1]!;
  s = s.replace(/^arxiv:/i, "");
  const m = NEW_STYLE.exec(s) ?? OLD_STYLE.exec(s);
  return m ? m[1] : undefined;
}

let registry: SchemaRegistry | undefined;
function contractErrors(value: unknown, file: string, fragment = ""): string[] {
  registry ??= loadContracts().registry;
  return registry.validate(value, schemaUri(file) + fragment).map((e) => `${e.instancePath || "/"} ${e.message}`);
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function shortId(prefix: string, ...parts: string[]): string {
  return `${prefix}${sha256(parts.join("\0")).slice(0, 24)}`;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Split into lines on LF (dropping a CR before it), keeping each line's exact bytes. */
export function splitLines(data: Uint8Array): Buffer[] {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const out: Buffer[] = [];
  let start = 0;
  while (start <= buf.length) {
    let end = buf.indexOf(0x0a, start);
    if (end === -1) end = buf.length;
    let line = buf.subarray(start, end);
    if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
    out.push(line);
    start = end + 1;
  }
  return out;
}

export function recordArxivId(rec: Record<string, unknown>): string | undefined {
  for (const key of ["arxiv_id", "url", "abs_url", "pdf_url"]) {
    const v = rec[key];
    if (typeof v === "string") {
      const id = normalizeArxivId(v);
      if (id !== undefined) return id;
    }
  }
  return undefined;
}

function canonicalFields(rec: Record<string, unknown>, arxivId: string): Record<string, unknown> {
  const fields: Record<string, unknown> = { arxiv_id: arxivId, venue: "arXiv" };
  if (Array.isArray(rec.authors) && rec.authors.every((a) => typeof a === "string")) fields.authors = rec.authors;
  for (const key of ["abstract", "published", "categories"]) if (rec[key] !== undefined) fields[key] = rec[key];
  return fields;
}

/**
 * Import one weekly papers JSONL file into `store`. Bad lines are reported in
 * the result and skipped; the rest of the file still imports. Re-importing a
 * file is a no-op (IDs are derived from corpus + content hash / arXiv ID).
 */
export function importPapersJsonl(data: Uint8Array | string, store: CorpusStore, opts: ImportOptions): ImportReport {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  const report: ImportReport = { records: 0, itemsCreated: 0, originalsCreated: 0, duplicateRecords: 0, errors: [] };

  splitLines(bytes).forEach((line, index) => {
    const lineNo = index + 1;
    const fail = (message: string) => report.errors.push({ line: lineNo, message });
    const text = line.toString("utf8");
    if (text.trim() === "") return;
    report.records++;

    let rec: unknown;
    try {
      rec = JSON.parse(text);
    } catch (e) {
      return fail(`invalid JSON: ${(e as Error).message}`);
    }
    if (!isObject(rec)) return fail("record is not a JSON object");

    const arxivId = recordArxivId(rec);
    if (arxivId === undefined) return fail("record has no arXiv ID");
    const title = typeof rec.title === "string" ? rec.title.trim() : "";
    if (title === "") return fail("record has no title");

    const captureHash = sha256(line);
    let source: Provenance;
    if (rec.provenance !== undefined) {
      const problems = contractErrors(rec.provenance, "common.schema.json", "#/$defs/provenance");
      if (problems.length > 0) return fail(`invalid provenance: ${problems.join("; ")}`);
      source = { ...(rec.provenance as unknown as Provenance) };
      source.hash ??= captureHash;
    } else {
      source = { source_kind: "upload", source: opts.source, recorded_by: opts.importedBy, at: opts.now, hash: captureHash };
    }

    // Capture: identical bytes already held are the same Original.
    let original = store.originalByHash(opts.corpusId, captureHash);
    if (original === undefined) {
      original = {
        id: shortId("cr_orig_", opts.corpusId, captureHash),
        corpus_id: opts.corpusId,
        content_hash: captureHash,
        media_type: "application/json",
        byte_size: line.byteLength,
        storage_uri: `${opts.storageUriPrefix}${captureHash}`,
        source,
        raw_metadata: rec,
        tombstoned_at: null,
        tombstone_reason: null,
      };
      const problems = contractErrors(original, "original.schema.json");
      if (problems.length > 0) return fail(`record does not form a valid Original: ${problems.join("; ")}`);
    }

    // Classify identity: dedup on arXiv ID.
    const existing = store.itemByArxivId(arxivId, opts.corpusId);
    let item: Item;
    if (existing !== undefined) {
      report.duplicateRecords++;
      if (existing.original_ids.includes(original.id)) return;
      item = { ...existing, original_ids: [...existing.original_ids, original.id], updated_at: opts.now };
    } else {
      const identity: Record<string, string> = { arxiv_id: arxivId, url: `https://arxiv.org/abs/${arxivId}` };
      if (typeof rec.doi === "string" && rec.doi !== "") identity.doi = rec.doi;
      item = {
        id: shortId("cr_item_", opts.corpusId, arxivId),
        corpus_id: opts.corpusId,
        item_type: "paper",
        title,
        summary: null,
        canonical_fields: canonicalFields(rec, arxivId),
        original_ids: [original.id],
        identity_keys: identity,
        status: "active",
        created_at: opts.now,
        updated_at: opts.now,
      };
    }
    const problems = contractErrors(item, "item.schema.json");
    if (problems.length > 0) return fail(`record does not form a valid Item: ${problems.join("; ")}`);

    if (store.original(original.id) === undefined) {
      store.putOriginal(original);
      report.originalsCreated++;
    }
    if (existing === undefined) report.itemsCreated++;
    store.putItem(item);
  });

  return report;
}
