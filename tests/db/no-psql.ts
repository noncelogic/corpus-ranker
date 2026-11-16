// Takes psql off this test process's PATH, so a code path that still spawns
// it fails here (ENOENT) as it would in the service image, which has none.
import assert from "node:assert/strict";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Drop every PATH entry holding a psql binary; asserts none is left. */
export function removePsqlFromPath(): void {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter((d) => d !== "" && !executable(join(d, "psql")));
  process.env.PATH = dirs.join(delimiter);
  assert.equal(dirs.some((d) => executable(join(d, "psql"))), false, "psql must not be on PATH");
}
