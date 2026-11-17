// CR-TEST-FIXTURE-NAMES: every Compose project the tests start is named by one
// shared helper (fixed prefix + fresh random UUID), never by process.pid plus
// a clock value, so two fixtures in one process or on one Docker host cannot
// collide and reuse or tear down each other's containers and volumes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { composeProjectName } from "./project-name.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Compose project names: lowercase letters, digits, dashes and underscores,
// starting with a letter or digit.
const validComposeProject = /^[a-z0-9][a-z0-9_-]*$/;

test("two Compose project names generated in the same process at the same clock instant differ, and each is a valid Compose project name", (t) => {
  t.mock.method(Date, "now", () => 1_700_000_000_000);
  const a = composeProjectName("crschema");
  const b = composeProjectName("crschema");
  assert.notEqual(a, b);
  for (const name of [a, b]) {
    assert.match(name, validComposeProject);
    assert.ok(name.startsWith("crschema"), name);
    assert.match(name, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.ok(!name.includes(String(process.pid)) || name.length > "crschema".length + 30, name);
  }
});

test("test fixtures name Compose projects only through the shared helper", () => {
  for (const file of ["tests/schema/fresh-db.ts", "tests/foundation/local-replica.test.ts"]) {
    const src = readFileSync(resolve(repoRoot, file), "utf8");
    assert.match(src, /composeProjectName\(/, `${file} must use composeProjectName`);
    assert.doesNotMatch(src, /process\.pid/, `${file} must not build names from process.pid`);
    assert.doesNotMatch(src, /Date\.now\(\)\s*%/, `${file} must not build names from a clock suffix`);
  }
});
