// Takes psql off this test process's PATH, so a code path that still spawns
// it fails here (ENOENT) as it would in the service image, which has none.
// Only psql is hidden: a PATH directory holding psql is replaced by a shadow
// directory that links to everything else in it, so binaries sharing that
// directory (docker, on most runners) stay resolvable.
import assert from "node:assert/strict";
import { accessSync, constants, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

const HIDDEN = "psql";

const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const shadows = new Map<string, string>();

/** A directory linking to every entry of `dir` except psql (one per `dir`, reused). */
function shadowWithoutPsql(dir: string): string {
  let shadow = shadows.get(dir);
  if (shadow === undefined) {
    shadow = mkdtempSync(join(tmpdir(), "cr-no-psql-"));
    for (const name of readdirSync(dir)) {
      // Absolute targets: a relative PATH entry would otherwise yield links
      // resolved against the shadow directory, which point nowhere.
      if (name !== HIDDEN) symlinkSync(resolve(dir, name), join(shadow, name));
    }
    shadows.set(dir, shadow);
    if (shadows.size === 1) process.once("exit", () => shadows.forEach((s) => rmSync(s, { recursive: true, force: true })));
  }
  return shadow;
}

/** `path` with every directory holding psql swapped for a shadow without it. */
export function pathWithoutPsql(path: string): string {
  return path
    .split(delimiter)
    .filter((d) => d !== "")
    .map((d) => (executable(join(d, HIDDEN)) ? shadowWithoutPsql(d) : d))
    .join(delimiter);
}

/** Hide psql (only psql) from this process's PATH; asserts none is left. */
export function removePsqlFromPath(): void {
  process.env.PATH = pathWithoutPsql(process.env.PATH ?? "");
  const dirs = process.env.PATH.split(delimiter);
  assert.equal(dirs.some((d) => executable(join(d, HIDDEN))), false, "psql must not be on PATH");
}
