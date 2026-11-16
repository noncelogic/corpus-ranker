// One command for the SPEC A5 bundle, against RANKER_DATABASE_URL through the
// in-process Postgres client, with the pg_dump client on PATH for the dump:
//   node src/export/cli.ts export <out-dir>       (npm run export -- <out-dir>)
//   node src/export/cli.ts restore <bundle-dir>   (into an empty database)
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config.ts";
import { cliSession, exportBundle, restoreBundle } from "./bundle.ts";

const USAGE = "usage: cli.ts export <out-dir> | restore <bundle-dir>";

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [command, dir] = argv;
  if ((command !== "export" && command !== "restore") || !dir) {
    console.error(USAGE);
    return 2;
  }
  const db = cliSession(loadConfig(env).databaseUrl);
  let manifest;
  try {
    manifest = command === "export" ? await exportBundle(db, dir) : await restoreBundle(db, dir);
  } finally {
    await db.end();
  }
  console.log(JSON.stringify({ [command === "export" ? "exported" : "restored"]: dir, counts: manifest.counts }));
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
