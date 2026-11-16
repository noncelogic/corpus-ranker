// Grants tracker CSV importer (SPEC §A7 Phase 2: the funding corpus).
//
// Each data row of a grants-tracker CSV export is one captured record. The
// row's exact bytes become an Original (content-addressed by their SHA-256; a
// quoted cell may span lines, so a row is a CSV record, not a physical line),
// and the funding program it describes becomes a `program` Item, deduplicated
// on its normalised program URL. A program seen in several rows (a new call,
// a later export) gets one Item resting on every distinct row; identical row
// bytes are one Original (SPEC §A3 capture).
//
// The header row names the columns; it is not an Original. Status, deadline
// and the tracker's provenance columns (Source, Added By, Added At) become
// canonical fields; the Original's provenance is the import itself.
import {
  CorpusStore,
  sha256,
  shortId,
  type ImportOptions,
  type ImportReport,
  type Item,
  type Original,
} from "./jsonl-importer.ts";
import { loadContracts, schemaUri, type SchemaRegistry } from "../contracts/index.ts";

/** The tracker export's column headers, matched case- and space-insensitively. */
export const TRACKER_COLUMNS = {
  program: "Program",
  funder: "Funder",
  url: "Program URL",
  status: "Status",
  deadline: "Deadline",
  amount: "Amount",
  source: "Source",
  addedBy: "Added By",
  addedAt: "Added At",
} as const;
type Column = keyof typeof TRACKER_COLUMNS;

/**
 * Canonical program URL for dedup: http(s) only, host lower-cased, fragment
 * dropped, trailing slash dropped from a non-root path. Undefined if unreadable.
 */
export function normalizeProgramUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  url.hash = "";
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}

interface CsvRecord {
  /** 1-based physical line the record starts on. */
  line: number;
  /** The record's exact bytes, without its line terminator. */
  bytes: Buffer;
}

/** Split CSV bytes into records on LF (dropping a CR before it) outside quoted cells. */
function splitRecords(buf: Buffer): CsvRecord[] {
  const out: CsvRecord[] = [];
  let start = 0;
  let line = 1;
  let startLine = 1;
  let quoted = false;
  for (let i = 0; i <= buf.length; i++) {
    const b = buf[i];
    if (b === 0x22) quoted = !quoted;
    else if (i === buf.length || (b === 0x0a && !quoted)) {
      let bytes = buf.subarray(start, i);
      if (bytes.at(-1) === 0x0d) bytes = bytes.subarray(0, -1);
      if (i < buf.length || bytes.length > 0) out.push({ line: startLine, bytes });
      start = i + 1;
      startLine = line + 1;
    }
    if (b === 0x0a) line++;
  }
  return out;
}

/** Parse one CSV record (RFC 4180 quoting) into its cells; undefined if malformed. */
function parseCells(text: string): string[] | undefined {
  const cells: string[] = [];
  let i = 0;
  for (;;) {
    let cell = "";
    if (text[i] === '"') {
      i++;
      for (;;) {
        const q = text.indexOf('"', i);
        if (q === -1) return undefined;
        cell += text.slice(i, q);
        if (text[q + 1] === '"') {
          cell += '"';
          i = q + 2;
        } else {
          i = q + 1;
          break;
        }
      }
      if (i < text.length && text[i] !== ",") return undefined;
    } else {
      const comma = text.indexOf(",", i);
      const end = comma === -1 ? text.length : comma;
      cell = text.slice(i, end);
      if (cell.includes('"')) return undefined;
      i = end;
    }
    cells.push(cell);
    if (i >= text.length) return cells;
    i++; // skip the comma
  }
}

const headerKey = (h: string) => h.trim().toLowerCase().replace(/\s+/g, " ");

let registry: SchemaRegistry | undefined;
function contractErrors(value: unknown, file: string): string[] {
  registry ??= loadContracts().registry;
  return registry.validate(value, schemaUri(file)).map((e) => `${e.instancePath || "/"} ${e.message}`);
}

/**
 * Import one grants-tracker CSV export into `store`. Bad rows are reported in
 * the result and skipped; the rest still import. A header without a Program
 * URL column rejects the whole file. Re-importing an export is a no-op.
 */
export function importTrackerCsv(data: Uint8Array | string, store: CorpusStore, opts: ImportOptions): ImportReport {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const report: ImportReport = { records: 0, itemsCreated: 0, originalsCreated: 0, duplicateRecords: 0, errors: [] };

  let records = splitRecords(buf);
  if (records[0]?.bytes[0] === 0xef && records[0].bytes[1] === 0xbb && records[0].bytes[2] === 0xbf) {
    records[0] = { ...records[0], bytes: records[0].bytes.subarray(3) };
  }
  records = records.filter((r) => r.bytes.toString("utf8").trim() !== "");
  const [headerRecord, ...rows] = records;
  if (headerRecord === undefined) return report;

  const header = parseCells(headerRecord.bytes.toString("utf8"));
  if (header === undefined) {
    report.errors.push({ line: headerRecord.line, message: "header is not valid CSV" });
    return report;
  }
  const index = new Map(header.map((h, i) => [headerKey(h), i]));
  const col = {} as Record<Column, number | undefined>;
  for (const [key, name] of Object.entries(TRACKER_COLUMNS) as [Column, string][]) col[key] = index.get(headerKey(name));
  for (const required of ["program", "url"] as const) {
    if (col[required] === undefined) {
      report.errors.push({ line: headerRecord.line, message: `header has no ${TRACKER_COLUMNS[required]} column` });
      return report;
    }
  }

  for (const row of rows) {
    const fail = (message: string) => report.errors.push({ line: row.line, message });
    report.records++;

    const cells = parseCells(row.bytes.toString("utf8"));
    if (cells === undefined) {
      fail("row is not valid CSV");
      continue;
    }
    if (cells.length !== header.length) {
      fail(`row has ${cells.length} cells, header has ${header.length}`);
      continue;
    }
    /** Trimmed cell for a known column; null when the column is absent or the cell empty. */
    const cell = (c: Column): string | null => {
      const i = col[c];
      const v = i === undefined ? "" : cells[i]!.trim();
      return v === "" ? null : v;
    };

    const rawUrl = cell("url");
    if (rawUrl === null) {
      fail("row has no program URL");
      continue;
    }
    const url = normalizeProgramUrl(rawUrl);
    if (url === undefined) {
      fail(`row has an unreadable program URL: ${rawUrl}`);
      continue;
    }
    const title = cell("program");
    if (title === null) {
      fail("row has no program name");
      continue;
    }

    const rawMetadata: Record<string, unknown> = {};
    header.forEach((h, i) => (rawMetadata[h] = cells[i]));

    // Capture: identical row bytes already held are the same Original.
    const captureHash = sha256(row.bytes);
    let original: Original | undefined = store.originalByHash(opts.corpusId, captureHash);
    if (original === undefined) {
      original = {
        id: shortId("cr_orig_", opts.corpusId, captureHash),
        corpus_id: opts.corpusId,
        content_hash: captureHash,
        media_type: "text/csv",
        byte_size: row.bytes.byteLength,
        storage_uri: `${opts.storageUriPrefix}${captureHash}`,
        source: { source_kind: "upload", source: opts.source, recorded_by: opts.importedBy, at: opts.now, hash: captureHash },
        raw_metadata: rawMetadata,
        tombstoned_at: null,
        tombstone_reason: null,
      };
      const problems = contractErrors(original, "original.schema.json");
      if (problems.length > 0) {
        fail(`row does not form a valid Original: ${problems.join("; ")}`);
        continue;
      }
    }

    // Classify identity: dedup on the normalised program URL.
    const existing = store.itemByUrl(url, opts.corpusId);
    let item: Item;
    if (existing !== undefined) {
      report.duplicateRecords++;
      if (existing.original_ids.includes(original.id)) continue;
      item = { ...existing, original_ids: [...existing.original_ids, original.id], updated_at: opts.now };
    } else {
      item = {
        id: shortId("cr_item_", opts.corpusId, "program", url),
        corpus_id: opts.corpusId,
        item_type: "program",
        title,
        summary: null,
        canonical_fields: {
          program_url: url,
          funder: cell("funder"),
          status: cell("status"),
          deadline: cell("deadline"),
          amount: cell("amount"),
          provenance: { source: cell("source"), added_by: cell("addedBy"), added_at: cell("addedAt") },
        },
        original_ids: [original.id],
        identity_keys: { url },
        status: "active",
        created_at: opts.now,
        updated_at: opts.now,
      };
    }
    const problems = contractErrors(item, "item.schema.json");
    if (problems.length > 0) {
      fail(`row does not form a valid Item: ${problems.join("; ")}`);
      continue;
    }

    if (store.original(original.id) === undefined) {
      store.putOriginal(original);
      report.originalsCreated++;
    }
    if (existing === undefined) report.itemsCreated++;
    store.putItem(item);
  }

  return report;
}
