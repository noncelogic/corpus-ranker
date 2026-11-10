// Versioned Postgres schema files for the ranker's own database (SPEC A2,
// TECH-STACK §2-§4). Files live in db/migrations as NNNN_name.sql, are applied
// in version order, each inside one transaction, and each records itself in
// schema_migrations. Applying them to the estate cluster is deployment work.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "db", "migrations");

export interface Migration {
  version: number;
  name: string;
  file: string;
  sql: string;
}

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** All migrations in version order; throws on malformed names or gaps. */
export function listMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  const migrations = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((file): Migration => {
      const m = FILE_RE.exec(file);
      if (!m) throw new Error(`migration file name must be NNNN_name.sql: ${file}`);
      return { version: Number(m[1]), name: m[2]!, file, sql: readFileSync(join(dir, file), "utf8") };
    })
    .sort((a, b) => a.version - b.version);
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) throw new Error(`migration versions must be contiguous from 1: ${m.file}`);
  });
  return migrations;
}
