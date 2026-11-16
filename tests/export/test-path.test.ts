// CR-TEST-PATH-DOCKER acceptance: the no-psql test PATH hides psql alone. On a
// runner where psql and docker share a directory (e.g. /usr/bin), dropping the
// whole directory also lost docker, which the export and restore tests spawn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathWithoutPsql } from "../db/no-psql.ts";

test("the test PATH leaves psql unresolvable and docker resolvable when both live in the same directory", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "cr-shared-bin-"));
  const bin = join(root, "runner", "bin");
  mkdirSync(bin, { recursive: true });
  const cwd = process.cwd();
  process.chdir(root);
  t.after(() => {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });
  for (const name of ["psql", "docker"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho ${name}-ran\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const shPath = (process.env.PATH ?? "").split(delimiter).filter((d) => d !== "" && d !== bin);
  const run = (cmd: string, path: string) => spawnSync(cmd, [], { env: { PATH: path }, encoding: "utf8" });

  // Runner layouts: the shared directory as an absolute PATH entry, and as a
  // relative one (resolved against the working directory, here `root`).
  for (const [layout, entry] of [
    ["absolute", bin],
    ["relative", join("runner", "bin")],
  ] as const) {
    await t.test(`${layout} PATH entry`, () => {
      const before = [entry, ...shPath].join(delimiter);
      assert.equal(run("psql", before).stdout.trim(), "psql-ran", "fixture: psql resolvable before");
      assert.equal(run("docker", before).stdout.trim(), "docker-ran", "fixture: docker resolvable before");

      const after = pathWithoutPsql(before);

      const psql = run("psql", after);
      assert.equal((psql.error as NodeJS.ErrnoException | undefined)?.code, "ENOENT", "psql must not resolve");
      const docker = run("docker", after);
      assert.equal(docker.error, undefined, "docker must still resolve");
      assert.equal(docker.stdout.trim(), "docker-ran");
      // Idempotent: hiding twice changes nothing further.
      assert.equal(pathWithoutPsql(after), after);
    });
  }
});
