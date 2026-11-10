// Fresh local database for schema contract tests: boots only the compose
// replica's pgvector Postgres under a throwaway project name, applies the
// versioned migrations in order, and exposes psql over `docker compose exec`
// (no Postgres client dependency on the host).
import type { TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { listMigrations } from "../../src/db/migrations.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const composeFile = resolve(repoRoot, "docker-compose.yaml");
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export interface FreshDb {
  /** Run SQL as the migration owner; returns trimmed tuples-only output. */
  psql(sql: string): string;
  /** Run SQL as the given role (via SET ROLE), returning output or throwing with psql's stderr. */
  psqlAs(role: string, sql: string): string;
  /** Run pg_dump against the database with the given arguments; returns its stdout. */
  pgDump(args: readonly string[]): string;
}

export interface FreshDbOptions {
  /** Apply the versioned migrations (default true); false leaves an empty instance. */
  migrate?: boolean;
}

export async function freshDatabase(t: TestContext, options: FreshDbOptions = {}): Promise<FreshDb> {
  const project = `crschema${process.pid}${Date.now() % 100000}`;
  const env = { ...process.env, RANKER_PG_PORT: "0", RANKER_MINIO_PORT: "0", RANKER_MINIO_CONSOLE_PORT: "0" };
  const compose = (args: string[], input?: string): string => {
    try {
      return execFileSync("docker", ["compose", "-f", composeFile, "-p", project, ...args], {
        cwd: repoRoot,
        env,
        encoding: "utf8",
        input,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      const e = err as { stderr?: string };
      throw new Error(`docker compose ${args.join(" ")} failed: ${e.stderr ?? String(err)}`, { cause: err });
    }
  };
  t.after(() => {
    try {
      compose(["down", "-v", "--remove-orphans"]);
    } catch {
      /* best-effort teardown */
    }
  });

  compose(["up", "-d", "--wait", "--wait-timeout", "300", "postgres"]);

  const run = (sql: string): string =>
    compose(
      [
        "exec", "-T", "-e", "PGPASSWORD=ranker", "postgres",
        "psql", "-h", "127.0.0.1", "-U", "ranker", "-d", "ranker", "-X", "-q",
        "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-",
      ],
      sql,
    ).trim();

  const deadline = Date.now() + 120_000;
  for (;;) {
    let last: unknown;
    try {
      if (run("select extname from pg_extension where extname = 'vector'") === "vector") break;
    } catch (err) {
      last = err;
    }
    if (Date.now() > deadline) throw new Error("postgres did not become ready within 120s", { cause: last });
    await sleep(1000);
  }

  if (options.migrate !== false) {
    for (const m of listMigrations()) {
      run(`\\set ON_ERROR_STOP 1\nBEGIN;\n${m.sql}\nCOMMIT;\n`);
    }
  }

  return {
    psql: run,
    psqlAs: (role, sql) => run(`SET ROLE ${role};\n${sql}`),
    pgDump: (args) =>
      compose([
        "exec", "-T", "-e", "PGPASSWORD=ranker", "postgres",
        "pg_dump", "-h", "127.0.0.1", "-U", "ranker", "-d", "ranker", ...args,
      ]),
  };
}
