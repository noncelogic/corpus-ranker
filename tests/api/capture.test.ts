// CR-M3-T1 acceptance: POST /v1/corpora/{corpus_id}/originals stores the
// captured record as an Original in the ranker database and returns its id and
// content hash; identical bytes captured again return the existing Original; a
// body that fails the frozen contract's CaptureRequest schema is answered 400
// and nothing is stored. Captured bytes, inline or fetched from source_url, are
// written to the object store before the Original is reported.
import { after, before, test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { loadContracts, openapiUri, schemaUri } from "../../src/contracts/index.ts";
import { createServer, loadConfig } from "../../src/server.ts";
import { s3ObjectStore, type ObjectStore } from "../../src/storage/object-store.ts";
import { freshDatabase, type FreshDb } from "../schema/fresh-db.ts";
import { removePsqlFromPath } from "../db/no-psql.ts";

const CORPUS = "cr_corpus_papers01";
const SERVICE = { user: "ranker_svc", password: "svc-local-only" };
const NOW = "2026-11-16T09:00:00.000Z";
const contracts = loadContracts();
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

let db: FreshDb;
let base: string;
let store: ObjectStore;
let source: string;
const served = new Map<string, { type: string; body: Buffer }>();
// Teardown registered at module level so it runs after every test, not after the hook.
const cleanups: (() => unknown)[] = [];
after(async () => {
  for (const fn of cleanups.reverse()) await fn();
});

before(
  async () => {
    // freshDatabase only needs the teardown hook of a TestContext.
    db = await freshDatabase({ after: (fn: () => unknown) => void cleanups.push(fn) } as unknown as TestContext, {
      minio: true,
    });
    db.psql(`insert into corpora (id, name, description, taxonomy_id, status)
               values ('${CORPUS}', 'papers', 'AI papers', 'cr_tax_papers1', 'active')`);
    // The service's login holds the app role, as deployment grants it (CR-D1).
    db.psql(`CREATE ROLE ${SERVICE.user} LOGIN PASSWORD '${SERVICE.password}' IN ROLE ranker_app`);
    // The service image has no psql; neither does this test process.
    removePsqlFromPath();
    // The default database and object store wiring, pointed at the replica.
    const config = loadConfig({ RANKER_S3_ENDPOINT: db.minioEndpoint, RANKER_DATABASE_URL: db.databaseUrl(SERVICE) });
    store = s3ObjectStore(config.objectStore);

    // A source the service fetches source_url captures from.
    const origin = createHttpServer((req, res) => {
      const doc = served.get(req.url ?? "");
      if (!doc) return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": doc.type }).end(doc.body);
    });
    await new Promise<void>((ok) => origin.listen(0, "127.0.0.1", ok));
    cleanups.push(() => new Promise((ok) => origin.close(ok)));
    source = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;

    // The service runs as the app role through its default in-process
    // database client; prove the role's grants suffice.
    const server = createServer(config, { now: () => new Date(NOW) });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    cleanups.push(() => new Promise((ok) => server.close(ok)));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  },
  { timeout: 600_000 },
);

function capture(body: unknown, corpus = CORPUS): Promise<Response> {
  return fetch(`${base}/v1/corpora/${corpus}/originals`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function request(bytes: Buffer, extra: Record<string, unknown> = {}) {
  return {
    content_base64: bytes.toString("base64"),
    media_type: "application/json",
    source: { source_kind: "feed", source: "https://export.arxiv.org/rss/cs.AI" },
    captured_by: "agent:intake-arxiv",
    raw_metadata: { arxiv_id: "2611.01234" },
    ...extra,
  };
}

const countOriginals = () => Number(db.psql("select count(*) from originals"));

test("a capture stores an Original and returns its id and content hash", async () => {
  const bytes = Buffer.from('{"arxiv_id":"2611.01234","title":"A paper"}');
  const res = await capture(request(bytes));
  assert.equal(res.status, 201);
  const original = (await res.json()) as Record<string, unknown>;

  assert.deepEqual(contracts.registry.validate(original, schemaUri("original.schema.json")), []);
  assert.equal(original.content_hash, sha256(bytes));
  assert.equal(original.corpus_id, CORPUS);
  assert.equal(original.byte_size, bytes.byteLength);
  assert.equal(original.media_type, "application/json");
  assert.deepEqual(original.raw_metadata, { arxiv_id: "2611.01234" });
  assert.deepEqual(original.source, {
    source_kind: "feed",
    source: "https://export.arxiv.org/rss/cs.AI",
    recorded_by: "agent:intake-arxiv",
    at: NOW,
    hash: sha256(bytes),
  });

  // Stored in the ranker database, as returned.
  const row = db.psql(`select id || '|' || content_hash || '|' || byte_size from originals where id = '${String(original.id)}'`);
  assert.equal(row, `${String(original.id)}|${sha256(bytes)}|${bytes.byteLength}`);

  // The bytes are retrievable from the object store under the storage URI.
  assert.equal(original.storage_uri, `s3://ranker-originals/${sha256(bytes)}`);
  assert.deepEqual(await store.get(sha256(bytes)), bytes);

  // Capture is raw intake only: no Item, Classification or Score appears.
  assert.equal(db.psql("select (select count(*) from items) + (select count(*) from classifications) + (select count(*) from score_events)"), "0");

  // A new record into the same corpus is its own Original.
  const other = Buffer.from('{"arxiv_id":"2611.02345","title":"Another paper"}');
  const res2 = await capture(request(other));
  assert.equal(res2.status, 201);
  const second = (await res2.json()) as Record<string, unknown>;
  assert.notEqual(second.id, original.id);
  assert.equal(second.content_hash, sha256(other));
});

test("a re-capture of identical bytes returns the existing Original", async () => {
  const bytes = Buffer.from("%PDF-1.7 identical bytes");
  const first = await capture(request(bytes, { media_type: "application/pdf" }));
  assert.equal(first.status, 201);
  const original = await first.json();
  const before = countOriginals();

  // Same bytes, different provenance and metadata: still the same Original.
  const again = await capture(
    request(bytes, {
      media_type: "application/pdf",
      source: { source_kind: "upload", source: "manual.pdf" },
      captured_by: "joe",
      raw_metadata: {},
    }),
  );
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), original);
  assert.equal(countOriginals(), before);
  assert.equal(db.psql(`select count(*) from originals where content_hash = '${sha256(bytes)}'`), "1");
});

test("a capture body that fails the contract schema is answered 400", async () => {
  const bytes = Buffer.from("never stored");
  const before = countOriginals();
  const valid = request(bytes);
  const { captured_by: _drop, ...noCapturedBy } = valid;
  const bad: [string, unknown][] = [
    ["missing captured_by", noCapturedBy],
    ["unknown property", { ...valid, score: 9 }],
    ["bad agent identity", { ...valid, captured_by: "Not An Agent!" }],
    ["bad source_kind", { ...valid, source: { source_kind: "carrier-pigeon", source: "x" } }],
    ["bytes without media_type", { ...valid, media_type: undefined }],
    ["both bytes and source_url", { ...valid, source_url: "https://arxiv.org/pdf/2611.01234" }],
    ["not an object", [valid]],
    ["invalid JSON", "{not json"],
    ["content not base64", { ...valid, content_base64: "@@not base64@@" }],
    // Names of Object.prototype members are not properties of the schema.
    ["inherited name toString", { ...valid, toString: "x" }],
    ["inherited name constructor", { ...valid, constructor: {} }],
    ["inherited name hasOwnProperty in source", { ...valid, source: { ...valid.source, hasOwnProperty: 1 } }],
    ["__proto__ property", JSON.stringify(valid).replace(/^\{/, '{"__proto__":{},')],
    ["source_url not http", { source_url: "file:///etc/passwd", source: valid.source, captured_by: valid.captured_by }],
  ];
  for (const [name, body] of bad) {
    const res = await capture(body);
    assert.equal(res.status, 400, name);
    const err = await res.json();
    assert.deepEqual(
      contracts.registry.validate(err, `${openapiUri()}#/components/schemas/Error`),
      [],
      `${name}: error body follows the contract`,
    );
  }
  // A malformed corpus id in the path is a client error too.
  assert.equal((await capture(valid, "not-a-corpus")).status, 400);
  assert.equal(countOriginals(), before, "nothing was stored");
});

test("a capture by source_url fetches, stores and dedups the bytes", async () => {
  const bytes = Buffer.from("%PDF-1.7 fetched from the source");
  served.set("/pdf/2611.01234", { type: "application/pdf; charset=binary", body: bytes });
  // The contract's default example shape: source_url, no bytes, no media_type.
  const body = {
    source_url: `${source}/pdf/2611.01234`,
    source: { source_kind: "feed", source: "https://export.arxiv.org/rss/cs.AI" },
    captured_by: "agent:intake-arxiv",
  };
  const res = await capture(body);
  assert.equal(res.status, 201);
  const original = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(contracts.registry.validate(original, schemaUri("original.schema.json")), []);
  assert.equal(original.content_hash, sha256(bytes));
  assert.equal(original.byte_size, bytes.byteLength);
  assert.equal(original.media_type, "application/pdf");
  assert.deepEqual(await store.get(sha256(bytes)), bytes);
  assert.equal(db.psql(`select count(*) from originals where content_hash = '${sha256(bytes)}'`), "1");

  // The same bytes again, by URL or inline, are the same Original.
  const again = await capture(body);
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), original);
  const inline = await capture(request(bytes, { media_type: "application/pdf" }));
  assert.equal(inline.status, 200);
  assert.equal(((await inline.json()) as Record<string, unknown>).id, original.id);
  assert.equal(db.psql(`select count(*) from originals where content_hash = '${sha256(bytes)}'`), "1");

  // A source that cannot be fetched is a client error and stores nothing.
  const before = countOriginals();
  const missing = await capture({ ...body, source_url: `${source}/pdf/absent` });
  assert.equal(missing.status, 400);
  assert.deepEqual(contracts.registry.validate(await missing.json(), `${openapiUri()}#/components/schemas/Error`), []);
  assert.equal(countOriginals(), before);
});

test("a capture into an unknown corpus is answered 404", async () => {
  const before = countOriginals();
  const res = await capture(request(Buffer.from("orphan")), "cr_corpus_missing");
  assert.equal(res.status, 404);
  assert.equal(countOriginals(), before);
});
