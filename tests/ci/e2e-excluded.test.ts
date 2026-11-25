// CR-E2E-JOURNEY acceptance: the read-only API journey (tests/e2e/) runs only
// through `npm run test:e2e`, never in `npm test` -- the fast pull-request job
// (.github/workflows/ci.yml `test`) stays unit tests (INTENTS I67), and the
// journey needs a running ranker the pull request does not have.
//
// The scripts are not read as text: the repository's package.json is copied
// into a scratch workspace with marker tests under tests/e2e/, tests/api/, a
// nested directory and deploy/, then `npm test` and `npm run test:e2e` run for real
// there and the markers each one ran are compared.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MARKERS = ["tests/e2e/journey", "tests/e2e/nested/deeper", "tests/top", "tests/api/unit", "tests/ci/nested/gate", "deploy/argocd/rollout"] as const;

/** A marker test that drops <name>.ran in $MARKER_DIR when it runs. */
const marker = (name: string) => `import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
test("${name}", () => writeFileSync(join(process.env.MARKER_DIR!, "${name.replaceAll("/", "__")}.ran"), ""));
`;

function workspace(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "e2e-excluded-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  cpSync(join(repoRoot, "package.json"), join(dir, "package.json"));
  for (const name of MARKERS) {
    const file = join(dir, `${name}.test.ts`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, marker(name));
  }
  return dir;
}

/** Runs `npm <args>` in `dir` and returns the markers that ran, sorted. */
function ran(dir: string, args: string[]): string[] {
  const out = join(dir, "ran");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out);
  // NODE_TEST_CONTEXT would make the nested `node --test` report to this run instead of running its files.
  const { NODE_TEST_CONTEXT: _, ...env } = process.env;
  const r = spawnSync("npm", args, { cwd: dir, encoding: "utf8", env: { ...env, MARKER_DIR: out, npm_config_update_notifier: "false" } });
  assert.equal(r.status, 0, `npm ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return existsSync(out) ? readdirSync(out).map((f) => f.replace(/\.ran$/, "").replaceAll("__", "/")).sort() : [];
}

test("the fast test glob excludes tests/e2e while test:e2e runs only tests/e2e", (t) => {
  const dir = workspace(t);
  assert.deepEqual(ran(dir, ["test", "--silent"]), ["deploy/argocd/rollout", "tests/api/unit", "tests/ci/nested/gate", "tests/top"], "npm test runs every test outside tests/e2e, deploy/ tests included, and none inside it");
  assert.deepEqual(ran(dir, ["run", "test:e2e", "--silent"]), ["tests/e2e/journey", "tests/e2e/nested/deeper"], "npm run test:e2e runs tests/e2e and nothing else");
});
