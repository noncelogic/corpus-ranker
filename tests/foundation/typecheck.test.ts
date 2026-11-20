// COND-283 regression lock: the test suite itself fails when any source, test
// or deploy file does not type-check, so a broken test double cannot pass as
// green.
//
// Culprit: 1b72a50418639c1e4835cb761b2fbb6f4e7deda8 (PR #70, CR-D1-PROMOTE).
// It made `ping(signal?)` a required member of `ObjectStore`
// (src/storage/object-store.ts) for the API's readiness probe, but did not
// update the hand-written store stub in
// tests/import/juno-historical-import.test.ts (added by #61), which had only
// put/get/uri. The stub's `importHistoricalExport(dir, db, store)` call then
// failed `tsc` with TS2345, and `ci` on main went red (run 44791735363).
// PR #74 added `async ping() {}` to the stub; no product code was missing it.
//
// Why pull-request checks missed it: they did not. PR #70's first head
// (b7ced0e) passed, and its final head (2227924, which added ping) failed
// `npm run typecheck` with this exact error (run 44775866705). The PR was
// merged red anyway, because GitHub's protection on main does not yet
// require the declared `ci-result` check (devops/github/branch-protection.json;
// tests/deploy/ci-gate.test.ts records that main currently reports no
// required checks). Applying that protection is a repository setting for the
// DevOps route (Rule: policies/placement-defaults.yaml#credentials,
// repository_settings), not something a product job can do.
//
// What this test adds: `node --test` runs TypeScript files by stripping
// types, so before this test a type error in a test file never failed
// `npm test`; only the separate typecheck step caught it. This test runs the
// compiler over the same project as `npm run typecheck` (tsconfig.json: src,
// tests, deploy) and fails on any diagnostic, so every run of the suite (the
// pull-request `test` job, `npm test` alone, or a single-directory run)
// catches the break. It takes a few seconds and needs no services.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

test("src, tests and deploy type-check under tsconfig.json with no diagnostics", () => {
  const configPath = resolve(repoRoot, "tsconfig.json");
  const read = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  assert.equal(read.error, undefined, "tsconfig.json must parse");
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, repoRoot, undefined, configPath);
  assert.deepEqual(parsed.errors, [], "tsconfig.json must be valid");
  assert.ok(
    parsed.fileNames.some((f) => f.endsWith("tests/import/juno-historical-import.test.ts")),
    "the project must include the test files, where the culprit's error was",
  );

  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  const report = ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (f) => f,
    getCurrentDirectory: () => repoRoot,
    getNewLine: () => "\n",
  });
  assert.equal(diagnostics.length, 0, `type errors (as \`npm run typecheck\` reports them):\n${report}`);
});
