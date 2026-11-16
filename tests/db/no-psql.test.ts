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

// Regression lock for the ci break fixed by PR #30.
// Culprit: 0839bfe "CR-M3-PGCLIENT: Reach Postgres through an in-process
// client instead of the psql CLI" (#25). It added removePsqlFromPath(), which
// dropped every PATH directory holding psql. On GitHub's ubuntu runners psql is
// /usr/bin/psql, so /usr/bin went too, and the next freshDatabase() in the same
// test process failed with `spawnSync docker ENOENT` (the export/restore
// tests via tests/export/session.ts, later also score and top-n).
// Why pull request checks missed it: on a host without psql (dev machines,
// agent sandboxes) removePsqlFromPath() removed nothing, so it passed locally;
// and the PR #25 run (and main after it) failed earlier at `npm run typecheck`
// (it collided with the Top-N API from #26, which still imported
// src/db/psql.ts), so `npm test` never ran until 9aff097 (#29) fixed the
// types and main went red at `npm test`. This test builds the runner's layout
// (psql beside docker) itself, so it fails on any host, needs no docker and
// runs in the `npm test` step of every pull request.
test("after psql is hidden, docker beside it still spawns as freshDatabase() calls it", (t) => {
  const usrBin = mkdtempSync(join(tmpdir(), "cr-nopsql-runner-"));
  const savedPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = savedPath;
    rmSync(usrBin, { recursive: true, force: true });
  });
  writeFileSync(join(usrBin, "psql"), "#!/bin/sh\nexit 0\n");
  writeFileSync(join(usrBin, "docker"), '#!/bin/sh\necho "docker $*"\n');
  chmodSync(join(usrBin, "psql"), 0o755);
  chmodSync(join(usrBin, "docker"), 0o755);
  process.env.PATH = [usrBin, savedPath].join(delimiter);

  removePsqlFromPath();

  // fresh-db.ts spawns docker with a copy of process.env taken after this point.
  const out = execFileSync("docker", ["compose", "version"], { env: { ...process.env }, encoding: "utf8" });
  assert.equal(out.trim(), "docker compose version");
});
