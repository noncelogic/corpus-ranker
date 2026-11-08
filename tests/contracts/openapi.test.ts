// CR-M1-T2 acceptance: the OpenAPI document covers every SPEC A3 operation and
// agrees with the A2 JSON Schemas (refs resolve, every A2 object is used, and
// every example in the document validates against its declared schema).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SCHEMA_VERSION,
  loadContracts,
  openapiUri,
  repoRoot,
  schemaUri,
} from "../../src/contracts/index.ts";

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options"] as const;

// Backticked operation names in the first column of the SPEC A3 table.
function specA3Operations(): string[] {
  const spec = readFileSync(join(repoRoot, "SPEC.md"), "utf8");
  const start = spec.indexOf("## A3. API surface");
  const end = spec.indexOf("\n## ", start + 1);
  assert.ok(start >= 0 && end > start, "SPEC.md must have an A3 section");
  return [...spec.slice(start, end).matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]!);
}

type Json = Record<string, any>;
const contracts = loadContracts();
const doc = contracts.openapi as Json;

interface Operation { method: string; path: string; op: Json; pointer: string }
function operations(): Operation[] {
  const out: Operation[] = [];
  for (const [path, item] of Object.entries(doc.paths as Json)) {
    for (const method of HTTP_METHODS) {
      const op = (item as Json)[method];
      if (op) out.push({ method, path, op, pointer: `#/paths/${path.replace(/~/g, "~0").replace(/\//g, "~1")}/${method}` });
    }
  }
  return out;
}

test("openapi document is OpenAPI 3.1 at the frozen schema version", () => {
  assert.match(doc.openapi, /^3\.1\.\d+$/);
  assert.equal(`v${String(doc.info.version).split(".")[0]}`, SCHEMA_VERSION);
  assert.equal(doc.jsonSchemaDialect, "https://json-schema.org/draft/2020-12/schema");
});

test("openapi document covers every A3 operation, and only those", () => {
  const specOps = specA3Operations();
  assert.ok(specOps.length >= 13, "SPEC.md A3 table must list the operations");
  const ids = operations().map((o) => o.op.operationId);
  assert.equal(new Set(ids).size, ids.length, "operationIds must be unique");
  assert.deepEqual([...ids].sort(), [...specOps].sort());
});

test("every operation declares a JSON request (writes) and a JSON 2xx response", () => {
  for (const { method, op } of operations()) {
    const ok = Object.entries(op.responses as Json).filter(([code]) => /^2\d\d$/.test(code));
    assert.ok(ok.length >= 1, `${op.operationId} needs a 2xx response`);
    for (const [, res] of ok) {
      assert.ok((res as Json).content?.["application/json"]?.schema, `${op.operationId} 2xx needs a JSON schema`);
    }
    if (method === "post") {
      assert.ok(op.requestBody?.content?.["application/json"]?.schema, `${op.operationId} needs a JSON request body`);
    }
  }
});

test("openapi schemas lint clean and every $ref resolves", () => {
  assert.deepEqual(contracts.registry.lint(), []);
});

test("every A2 object schema is referenced by the openapi document", () => {
  const referenced = new Set(contracts.registry.reachableFrom(openapiUri()));
  for (const file of Object.values(contracts.manifest.objects)) {
    assert.ok(referenced.has(schemaUri(file)), `${file} is not used by the API contract`);
  }
});

test("every example in the openapi document validates against its schema", () => {
  let checked = 0;
  for (const { op, pointer } of operations()) {
    const media: [string, Json][] = [];
    const body = op.requestBody?.content?.["application/json"];
    if (body) media.push([`${pointer}/requestBody/content/application~1json`, body]);
    for (const [code, res] of Object.entries(op.responses as Json)) {
      const m = (res as Json).content?.["application/json"];
      if (m) media.push([`${pointer}/responses/${code}/content/application~1json`, m]);
    }
    for (const [mediaPointer, m] of media) {
      const examples = contracts.mediaExamples(m);
      if (/requestBody|responses\/2/.test(mediaPointer)) {
        assert.ok(examples.length >= 1, `${op.operationId}: ${mediaPointer} needs an example`);
      }
      for (const [name, value] of examples) {
        const errors = contracts.registry.validate(value, `${openapiUri()}${mediaPointer}/schema`);
        assert.deepEqual(errors, [], `${op.operationId} example ${name}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 0);
});
