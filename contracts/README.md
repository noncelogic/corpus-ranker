# API contract (frozen at v1)

- `schemas/v1/*.schema.json` — JSON Schema (draft 2020-12) for each SPEC A2 object; `schemas/v1/index.json` maps
  SPEC section → schema. `common.schema.json` holds the shared IDs, provenance (SPEC §4) and evidence pointers.
- `examples/v1/<object>/{valid,invalid}/*.json` — example payloads each schema must accept / reject.
- `openapi.json` — OpenAPI 3.1 REST binding of the SPEC A3 operations; `operationId` is the A3 operation name.
  Domain objects are `$ref`s into `schemas/v1/`, and response examples point at the example payloads.

`npm run test:contracts` keeps these in agreement: every A2 section has a schema, every A3 operation has an
operation, every `$ref` resolves, and every example validates. Schemas are checked by the small validator in
`src/contracts/json-schema.ts`, which rejects keywords it does not enforce.

Within v1, changes are additive only. A breaking change to an object or operation means a new
`schemas/v2/` and a new major `info.version`.
