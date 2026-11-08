// CR-M1-T1 acceptance: a clean checkout builds the ranker service skeleton.
//
// "Clean checkout" is simulated by copying exactly the files git would hand a
// fresh clone (tracked files plus not-yet-committed, non-ignored files) into
// an empty directory, so stale build output or ignored local files cannot
// make the build pass. Dependencies come from the existing install
// (`npm ci` in CI), linked rather than re-downloaded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function checkoutFiles(): string[] {
  const out = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  return out.split("\0").filter((f) => f.length > 0 && existsSync(join(repoRoot, f)));
}

test("clean checkout builds the service skeleton", async (t) => {
  const workdir = mkdtempSync(join(tmpdir(), "corpus-ranker-checkout-"));
  t.after(() => rmSync(workdir, { recursive: true, force: true }));

  const files = checkoutFiles();
  for (const required of ["package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json", "src/server.ts"]) {
    assert.ok(files.includes(required), `${required} must be part of the checkout`);
  }
  assert.ok(!files.some((f) => f.startsWith("dist/")), "build output must not be checked in");

  for (const f of files) {
    cpSync(join(repoRoot, f), join(workdir, f), { recursive: false });
  }
  assert.ok(existsSync(join(repoRoot, "node_modules")), "run `npm ci` before the test suite");
  symlinkSync(join(repoRoot, "node_modules"), join(workdir, "node_modules"), "dir");

  execFileSync("npm", ["run", "--silent", "build"], { cwd: workdir, stdio: "pipe" });

  const entry = join(workdir, "dist", "server.js");
  assert.ok(existsSync(entry), "build must emit dist/server.js");

  // The built skeleton must load and answer its health endpoint.
  const mod = (await import(pathToFileURL(entry).href)) as typeof import("../../src/server.ts");
  const server = mod.createServer(mod.loadConfig({}));
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(() => server.close());
  const { port } = server.address() as AddressInfo;

  const res = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: "ok", service: "ranker" });

  const missing = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(missing.status, 404);
});
