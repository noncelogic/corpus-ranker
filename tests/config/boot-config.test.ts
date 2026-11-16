// CR-D1-SECRETS acceptance: the service refuses to start when its API key set
// or its object-store credentials are absent. `loadServiceConfig` is what the
// server entry point (src/server.ts) runs at boot; unlike `loadConfig` it
// falls back to no local default for a secret, and its errors name what is
// missing without ever echoing a secret value.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadServiceConfig } from "../../src/config.ts";
import { repoRoot } from "../deploy/render.ts";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const S3_SECRET = "s3-secret-value-never-echoed";

function keyDir(t: { after: (fn: () => void) => void }, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "ranker-api-keys-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), value);
  return dir;
}

const baseEnv = (apiKeysDir: string | undefined): Record<string, string | undefined> => ({
  RANKER_API_KEYS_DIR: apiKeysDir,
  RANKER_S3_ACCESS_KEY_ID: "ranker",
  RANKER_S3_SECRET_ACCESS_KEY: S3_SECRET,
});

/** Assert `fn` throws naming `needle`, and that no secret leaks into the message. */
function refuses(fn: () => unknown, needle: RegExp): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, needle);
    for (const secret of [KEY_A, KEY_B, S3_SECRET]) assert.ok(!err.message.includes(secret), "boot error echoes a secret");
    return true;
  });
}

test("with an API key set and object-store credentials present, the service config loads every principal's key", (t) => {
  // A Kubernetes Secret volume also holds `..data` / `..<timestamp>` entries; they are not principals.
  const dir = keyDir(t, { juno: `${KEY_A}\n`, hermes: KEY_B });
  mkdirSync(join(dir, "..2026_11_16_00_00_00.000000000"));
  symlinkSync("..2026_11_16_00_00_00.000000000", join(dir, "..data"));
  const config = loadServiceConfig(baseEnv(dir));
  assert.deepEqual([...config.apiKeys.entries()].sort(), [
    ["hermes", KEY_B],
    ["juno", KEY_A],
  ]);
  assert.equal(config.objectStore.accessKeyId, "ranker");
  assert.equal(config.objectStore.secretAccessKey, S3_SECRET);
});

test("the service refuses to start without its API key set", (t) => {
  refuses(() => loadServiceConfig(baseEnv(undefined)), /RANKER_API_KEYS_DIR/);
  refuses(() => loadServiceConfig(baseEnv("")), /RANKER_API_KEYS_DIR/);
  // An uncreated child of a test-owned directory (cleaned up by keyDir), so nothing else can populate it.
  const missingDir = join(keyDir(t, {}), "no-such-dir");
  refuses(() => loadServiceConfig(baseEnv(missingDir)), /API key/i);
  refuses(() => loadServiceConfig(baseEnv(keyDir(t, {}))), /no API keys/i);
  refuses(() => loadServiceConfig(baseEnv(keyDir(t, { juno: KEY_A, hermes: "  \n" }))), /hermes/);
  refuses(() => loadServiceConfig(baseEnv(keyDir(t, { juno: KEY_A, hermes: KEY_A }))), /same API key/i);
});

test("the service refuses to start without its object-store credentials", (t) => {
  const dir = keyDir(t, { juno: KEY_A });
  for (const name of ["RANKER_S3_ACCESS_KEY_ID", "RANKER_S3_SECRET_ACCESS_KEY"]) {
    refuses(() => loadServiceConfig({ ...baseEnv(dir), [name]: undefined }), new RegExp(name));
    refuses(() => loadServiceConfig({ ...baseEnv(dir), [name]: "" }), new RegExp(name));
  }
});

test("the server entry point exits non-zero at boot when its secrets are absent, without listening", () => {
  const entry = resolve(repoRoot, "src", "server.ts");
  let failure: { status: number | null; signal: string | null; stdout: string; stderr: string } | undefined;
  try {
    execFileSync(process.execPath, [entry], {
      env: { PATH: process.env.PATH, RANKER_HOST: "127.0.0.1", RANKER_PORT: "0" },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
  } catch (err) {
    failure = err as NonNullable<typeof failure>;
  }
  assert.ok(failure, "the server started without its API keys or object-store credentials");
  assert.equal(failure.signal, null, "the server kept running until the timeout killed it");
  assert.notEqual(failure.status, 0);
  assert.doesNotMatch(failure.stdout + failure.stderr, /listening/);
  assert.match(failure.stderr, /RANKER_API_KEYS_DIR/);
  assert.match(failure.stderr, /RANKER_S3_ACCESS_KEY_ID/);
  assert.match(failure.stderr, /RANKER_S3_SECRET_ACCESS_KEY/);
});
