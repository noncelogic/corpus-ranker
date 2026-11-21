// COND-283 regression lock: the test suite itself fails when any source, test
// or deploy file does not type-check, so a broken test double cannot pass as
// green.
//
// Culprit: 1b72a50418639c1e4835cb761b2fbb6f4e7deda8 (PR #70, CR-D1-PROMOTE),
// the only commit in 84a8611..1b72a50. It made `ping(signal?)` a required
// member of `ObjectStore` (src/storage/object-store.ts) for the API's
// readiness probe and added `ping` to the one store stub its base (50201b1)
// had, in tests/import/juno-historical-import.test.ts.
//
// Root cause: a semantic merge race. While #70 was open, #71 (ba98ffb,
// merged 16:07Z) added a second hand-written stub to the same file with
// only put/get/uri. Each change type-checked against its own base; together
// the stub's `importHistoricalExport(dir, db, store)` call failed `tsc` with
// TS2345 at line 124, and `ci` on main went red (run 44791735363). PR #74
// added `async ping() {}` to that stub; no product code was missing it.
//
// Why pull-request checks missed it: they did not miss it; the merge was not
// gated on them. PR #70's run on its first head (b7ced0e, run 44745432161)
// passed because #71 was not on main yet. The run on its final head
// (2227924, run 44775866705, tested on top of a main that had #71) failed
// `npm run typecheck` with this exact error. The PR was merged red anyway at
// 18:19Z, because GitHub's protection on main does not yet require the
// declared `ci-result` check (devops/github/branch-protection.json;
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
