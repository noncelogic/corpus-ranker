// CR-D1-SECRETS-ROLLOUT acceptance: deploy/openbao/generate-api-keys.sh, run
// estate-side, writes one fresh API key per principal CR-D1-DEC-PRINCIPALS
// authorises to the product custody path kv/corpus-ranker/api-keys and prints
// no key value (meta-harness AGENTS.md local-first delivery rule 4).
//
// The authorised set follows Rule: policies/placement-defaults.yaml#service_access:
// at the first deployment the owner's principal (`joe`, the identity the
// service already records for Joe) gets a key with full scope; the agent
// principals (CortexPlane, Hermes) get theirs in a later routine decision,
// each scoped to its loop; Juno gets no new keys.
//
// The script is run twice: against a stand-in `bao` that records exactly what
// it is handed, and against a throwaway OpenBao dev server through the real
// bao CLI, which is where the keys are read back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { repoRoot } from "./render.ts";
import { startDevOpenBao } from "./openbao-dev.ts";

const script = resolve(repoRoot, "deploy", "openbao", "generate-api-keys.sh");
const AUTHORISED = ["joe"];
const KEY = /^[0-9a-f]{64}$/;

function binDir(t: { after(fn: () => void): void }, bao: string): NodeJS.ProcessEnv {
  const bin = mkdtempSync(join(tmpdir(), "fake-bao-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(join(bin, "bao"), bao.replaceAll("@BIN@", bin));
  chmodSync(join(bin, "bao"), 0o755);
  return { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_BIN: bin };
}

test("the generator hands bao one fresh key per authorised principal for kv/corpus-ranker/api-keys, on stdin, and prints none", (t) => {
  // A stand-in `bao` that records its arguments and stdin, and prints what the real CLI would.
  const env = binDir(
    t,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "@BIN@/args"\ncat > "@BIN@/stdin"\necho "== Secret Path ==" ; echo "kv/data/corpus-ranker/api-keys"\nexit "\${FAKE_BAO_EXIT:-0}"\n`,
  );
  const bin = env.FAKE_BIN!;

  const run = spawnSync(script, [], { env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const args = readFileSync(join(bin, "args"), "utf8").trim().split("\n");
  assert.deepEqual(args, ["kv", "put", "-mount=kv", "-cas=0", "corpus-ranker/api-keys", "-"], "keys go to kv/corpus-ranker/api-keys, never overwriting an existing set");
  const written = JSON.parse(readFileSync(join(bin, "stdin"), "utf8")) as Record<string, string>;
  assert.deepEqual(Object.keys(written).sort(), AUTHORISED, "one key per authorised principal, and no other");
  for (const key of Object.values(written)) {
    assert.match(key, KEY, "each key is 256 random bits, hex");
    assert.ok(!run.stdout.includes(key) && !run.stderr.includes(key), "the script echoed an API key");
    assert.ok(!args.join(" ").includes(key), "a key went on argv");
  }
  assert.doesNotMatch(run.stdout + run.stderr, /Secret Path/, "the bao CLI's output is not passed through");

  // A second run draws new keys.
  const again = spawnSync(script, [], { env, encoding: "utf8" });
  assert.equal(again.status, 0, again.stderr);
  const second = JSON.parse(readFileSync(join(bin, "stdin"), "utf8")) as Record<string, string>;
  for (const p of AUTHORISED) assert.notEqual(second[p], written[p], `principal ${p} got the same key twice`);

  // The principal set is fixed by the decision, not by the operator: no principal
  // may be named on the command line, least of all one the rule withholds a key from.
  rmSync(join(bin, "args"));
  for (const extra of [["juno"], ["hermes"], ["cortexplane"], ["joe"], ["joe", "juno"], ["../x"]]) {
    assert.notEqual(spawnSync(script, extra, { env, encoding: "utf8" }).status, 0, `accepted principals ${JSON.stringify(extra)}`);
  }
  assert.throws(() => readFileSync(join(bin, "args")), /ENOENT/, "a refused run must not reach OpenBao");

  const failed = spawnSync(script, [], { env: { ...env, FAKE_BAO_EXIT: "2" }, encoding: "utf8" });
  assert.notEqual(failed.status, 0, "a failed OpenBao write must fail the script");

  // POSIX sh, never traced (tracing would print the keys).
  const text = readFileSync(script, "utf8");
  assert.match(text, /^#!\/bin\/sh\n/);
  assert.doesNotMatch(text, /set -[a-z]*x|set -o xtrace/);
  execFileSync("sh", ["-n", script]);
});

test("run against OpenBao, the generator stores one key per authorised principal at kv/corpus-ranker/api-keys and refuses to overwrite it", { timeout: 300_000 }, async (t) => {
  const bao = await startDevOpenBao(t);
  // The real bao CLI, inside the dev server, logged in as an operator (root here).
  const env = binDir(t, `#!/bin/sh\nexec docker exec -i -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN=root ${bao.name} bao "$@"\n`);

  const run = spawnSync(script, [], { env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stdout + run.stderr);

  const stored = JSON.parse(bao.root("kv", "get", "-format=json", "-mount=kv", "corpus-ranker/api-keys")).data;
  const keys = stored.data as Record<string, string>;
  assert.deepEqual(Object.keys(keys).sort(), AUTHORISED, "kv/corpus-ranker/api-keys holds exactly the authorised principals");
  for (const [principal, key] of Object.entries(keys)) {
    assert.match(key, KEY, `${principal}'s key is 256 random bits, hex`);
    assert.ok(!run.stdout.includes(key) && !run.stderr.includes(key), "the script echoed an API key");
  }
  assert.equal(stored.metadata.version, 1);
  // Nothing else was written under the product path.
  assert.deepEqual(JSON.parse(bao.root("kv", "list", "-format=json", "-mount=kv", "corpus-ranker")), ["api-keys"]);

  // A second run is refused (check-and-set 0) and leaves the stored keys alone.
  const again = spawnSync(script, [], { env, encoding: "utf8" });
  assert.notEqual(again.status, 0, "an existing key set must never be overwritten");
  assert.match(again.stderr, /never overwritten/);
  const after = JSON.parse(bao.root("kv", "get", "-format=json", "-mount=kv", "corpus-ranker/api-keys")).data;
  assert.deepEqual(after.data, keys);
  assert.equal(after.metadata.version, 1);
  for (const key of Object.values(keys)) assert.ok(!again.stdout.includes(key) && !again.stderr.includes(key), "a refused run echoed an API key");
});
