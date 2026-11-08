// CR-M1-T2 acceptance: every SPEC A2 object has a versioned JSON Schema, and
// every schema accepts its valid example payloads and rejects its invalid ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  SCHEMA_VERSION,
  contractsRoot,
  listExamples,
  loadContracts,
  repoRoot,
  schemaUri,
} from "../../src/contracts/index.ts";

// "### A2.N Title" headings in SPEC.md are the source of truth for the A2 object list.
function specA2Sections(): string[] {
  const spec = readFileSync(join(repoRoot, "SPEC.md"), "utf8");
  return [...spec.matchAll(/^### (A2\.\d+) /gm)].map((m) => m[1]!);
}

const contracts = loadContracts();

test("every SPEC A2 object has exactly one schema in the versioned manifest", () => {
  const sections = specA2Sections();
  assert.ok(sections.length >= 10, "SPEC.md must list the A2 objects");
  assert.deepEqual(Object.keys(contracts.manifest.objects).sort(), [...sections].sort());
  const files = Object.values(contracts.manifest.objects);
  assert.equal(new Set(files).size, files.length, "one schema per A2 object");
  assert.equal(contracts.manifest.version, SCHEMA_VERSION);
});

test("schemas are well-formed: versioned $id, known keywords only, resolvable $refs", () => {
  for (const file of contracts.schemaFiles) {
    const schema = contracts.registry.get(schemaUri(file)) as Record<string, unknown>;
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema", file);
    assert.match(String(schema.$id), new RegExp(`/${SCHEMA_VERSION}/${file.replace(".", "\\.")}$`), file);
  }
  assert.deepEqual(contracts.registry.lint(), []);
});

for (const [section, file] of Object.entries(contracts.manifest.objects)) {
  test(`${section} ${file} validates its example payloads`, () => {
    const name = file.replace(/\.schema\.json$/, "");
    const { valid, invalid } = listExamples(name);
    assert.ok(valid.length >= 1, `${name} needs at least one valid example`);
    assert.ok(invalid.length >= 1, `${name} needs at least one invalid example`);
    for (const ex of valid) {
      const errors = contracts.registry.validate(JSON.parse(readFileSync(ex, "utf8")), schemaUri(file));
      assert.deepEqual(errors, [], `${ex.slice(contractsRoot.length + 1)} should be valid`);
    }
    for (const ex of invalid) {
      const errors = contracts.registry.validate(JSON.parse(readFileSync(ex, "utf8")), schemaUri(file));
      assert.notDeepEqual(errors, [], `${ex.slice(contractsRoot.length + 1)} should be rejected`);
    }
  });
}
