// SPEC A3 `capture` over the frozen REST contract (contracts/openapi.json,
// operationId capture): raw material becomes an Original in the ranker
// database, content-addressed by the SHA-256 of its bytes. Identical bytes
// captured again into the same corpus return the existing Original (the
// originals table is UNIQUE on corpus + content hash). Capture is raw intake
// only: it never classifies or scores inline.
import { loadContracts, openapiUri, schemaUri, type SchemaRegistry } from "../contracts/index.ts";
import { literal, type Sql } from "../db/psql.ts";
import { sha256, shortId, type Original, type Provenance } from "../import/jsonl-importer.ts";

export interface CaptureRequest {
  content_base64?: string;
  media_type?: string;
  source_url?: string;
  source: Pick<Provenance, "source_kind" | "source">;
  captured_by: string;
  raw_metadata?: Record<string, unknown>;
}

export interface CaptureDeps {
  sql: Sql;
  now: () => Date;
  /** Object store bucket the content-addressed storage URI names. */
  bucket: string;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

let registry: SchemaRegistry | undefined;
function contractErrors(value: unknown, uri: string): string[] {
  registry ??= loadContracts().registry;
  return registry.validate(value, uri).map((e) => `${e.instancePath || "/"} ${e.message}`);
}

const CAPTURE_REQUEST = () => `${openapiUri()}#/components/schemas/CaptureRequest`;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

const error = (status: number, code: string, message: string): ApiResponse => ({ status, body: { error: code, message } });

// One Original as its v1 contract object (same shape as the export bundle).
const ORIGINAL_JSON = `json_build_object('id', o.id, 'corpus_id', o.corpus_id, 'content_hash', o.content_hash,
  'media_type', o.media_type, 'byte_size', o.byte_size, 'storage_uri', o.storage_uri,
  'source', o.source, 'raw_metadata', o.raw_metadata,
  'tombstoned_at', to_char(o.tombstoned_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'tombstone_reason', o.tombstone_reason)`;

/** Handle POST /v1/corpora/{corpus_id}/originals with an already-read request body. */
export async function capture(corpusId: string, rawBody: string, deps: CaptureDeps): Promise<ApiResponse> {
  const badPath = contractErrors(corpusId, schemaUri("common.schema.json") + "#/$defs/corpus_id");
  if (badPath.length > 0) return error(400, "invalid_corpus_id", `corpus_id ${badPath.join("; ")}`);

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch (e) {
    return error(400, "invalid_json", `request body is not JSON: ${(e as Error).message}`);
  }
  const problems = contractErrors(body, CAPTURE_REQUEST());
  if (problems.length > 0) return error(400, "invalid_request", problems.join("; "));
  const req = body as CaptureRequest;

  if (req.content_base64 === undefined) {
    // The contract also admits capture by source_url alone; fetching the bytes
    // is not built yet, and without bytes there is no content hash to store.
    return error(400, "unsupported_capture", "capture by source_url without content_base64 is not supported yet");
  }
  if (!BASE64.test(req.content_base64)) return error(400, "invalid_request", "/content_base64 must be base64");
  const bytes = Buffer.from(req.content_base64, "base64");
  const hash = sha256(bytes);

  const original: Original = {
    id: shortId("cr_orig_", corpusId, hash),
    corpus_id: corpusId,
    content_hash: hash,
    media_type: req.media_type!,
    byte_size: bytes.byteLength,
    storage_uri: `s3://${deps.bucket}/${hash}`,
    source: {
      source_kind: req.source.source_kind,
      source: req.source.source,
      recorded_by: req.captured_by,
      at: deps.now().toISOString(),
      hash,
    },
    raw_metadata: req.raw_metadata ?? {},
    tombstoned_at: null,
    tombstone_reason: null,
  };
  const invalid = contractErrors(original, schemaUri("original.schema.json"));
  if (invalid.length > 0) return error(400, "invalid_request", `capture does not form a valid Original: ${invalid.join("; ")}`);

  // Insert unless these bytes are already held in the corpus; either way answer
  // with the stored Original. A concurrent capture of the same bytes may commit
  // between our snapshot and our insert, so a miss is retried once.
  const c = literal(corpusId);
  const h = literal(hash);
  const statement = `SET standard_conforming_strings = on;
    with ins as (
      insert into originals (id, corpus_id, content_hash, media_type, byte_size, storage_uri, source, raw_metadata)
      select ${literal(original.id)}, ${c}, ${h}, ${literal(original.media_type)}, ${original.byte_size},
             ${literal(original.storage_uri)}, ${literal(JSON.stringify(original.source))}::jsonb,
             ${literal(JSON.stringify(original.raw_metadata))}::jsonb
      where exists (select 1 from corpora where id = ${c})
      on conflict (corpus_id, content_hash) do nothing
      returning *
    )
    select json_build_object('corpus', true, 'created', true, 'original', ${ORIGINAL_JSON}) from ins o
    union all
    select json_build_object('corpus', true, 'created', false, 'original', ${ORIGINAL_JSON})
      from originals o where o.corpus_id = ${c} and o.content_hash = ${h} and not exists (select 1 from ins)
    union all
    select json_build_object('corpus', false) where not exists (select 1 from corpora where id = ${c});`;

  for (let attempt = 0; attempt < 2; attempt++) {
    const out = await deps.sql(statement);
    if (out === "") continue;
    const result = JSON.parse(out) as { corpus: boolean; created?: boolean; original?: Original };
    if (!result.corpus) return error(404, "corpus_not_found", `no corpus ${corpusId}`);
    return { status: result.created ? 201 : 200, body: result.original };
  }
  throw new Error(`capture of ${hash} into ${corpusId} neither inserted nor found an Original`);
}
