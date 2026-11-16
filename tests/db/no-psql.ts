// Takes psql off this test process's PATH, so a code path that still spawns
// it fails here (ENOENT) as it would in the service image, which has none.
// Only psql is hidden: a PATH directory holding it (e.g. /usr/bin on GitHub's
// ubuntu runners, next to docker, git and sh) is replaced by a shadow
// directory linking to everything else in it, so the rest stays runnable.
import assert from "node:assert/strict";
import { accessSync, constants, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const shadowed = new Set<string>();

/** A directory with links to every entry of `dir` except psql. */
function shadowWithoutPsql(dir: string): string {
  const shadow = mkdtempSync(join(tmpdir(), "cr-nopsql-path-"));
  shadowed.add(shadow);
  if (shadowed.size === 1) {
    process.once("exit", () => {
      for (const d of shadowed) rmSync(d, { recursive: true, force: true });
    });
  }
  for (const name of readdirSync(dir)) {
    if (name !== "psql") symlinkSync(join(dir, name), join(shadow, name));
  }
  return shadow;
}

/** Hide every psql binary on PATH, keeping the other programs reachable; asserts none is left. */
export function removePsqlFromPath(): void {
  const dirs = (process.env.PATH ?? "")
    .split(delimiter)
    .filter((d) => d !== "")
    .map((d) => (executable(join(d, "psql")) ? shadowWithoutPsql(d) : d));
  process.env.PATH = dirs.join(delimiter);
  assert.equal(dirs.some((d) => executable(join(d, "psql"))), false, "psql must not be on PATH");
}
