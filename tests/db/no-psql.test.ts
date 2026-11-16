// removePsqlFromPath must hide only psql. On GitHub's ubuntu runners psql sits
// in /usr/bin next to docker, git and sh; dropping the whole directory left
// later tests in the same process unable to spawn docker (ENOENT).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { execFileSync } from "node:child_process";
import { removePsqlFromPath } from "./no-psql.ts";

test("taking psql off PATH keeps the other programs in its directory runnable", (t) => {
  const bin = mkdtempSync(join(tmpdir(), "cr-nopsql-"));
  const savedPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = savedPath;
    rmSync(bin, { recursive: true, force: true });
  });
  for (const name of ["psql", "neighbour-tool"]) {
    writeFileSync(join(bin, name), `#!/bin/sh\necho ${name}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  process.env.PATH = [bin, savedPath].join(delimiter);
  assert.equal(execFileSync("psql", { encoding: "utf8" }).trim(), "psql");

  removePsqlFromPath();

  assert.throws(() => execFileSync("psql", { stdio: "ignore" }), { code: "ENOENT" });
  assert.equal(execFileSync("neighbour-tool", { encoding: "utf8" }).trim(), "neighbour-tool");
});
