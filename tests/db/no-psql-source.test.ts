// CR-M3-PGCLIENT: no code path spawns psql. The shipped image has no psql, so
// any source file that names it as a program to run would fail there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

test("no source file runs the psql program", () => {
  const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length > 0);
  const offenders = files.filter((f) => /["'`]psql["'`]/.test(readFileSync(join(src, f), "utf8")));
  assert.deepEqual(offenders, []);
});
