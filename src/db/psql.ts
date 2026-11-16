// The service's access to its own Postgres database: SQL text in, psql
// tuples-only unaligned output out (the same semantics the export CLI uses),
// with no Postgres client library dependency.
import { spawn } from "node:child_process";

/** Run SQL (psql semantics, stop on first error); resolves with trimmed tuples-only output. */
export type Sql = (sql: string) => Promise<string>;

/** An Sql runner that drives the psql client on PATH against `databaseUrl`. */
export function psqlClient(databaseUrl: string): Sql {
  const args = ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-", "-d", databaseUrl];
  return (sql) =>
    new Promise((resolve, reject) => {
      const child = spawn("psql", args, { stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`psql exited ${String(code)}: ${err.trim()}`))));
      child.stdin.end(sql);
    });
}

/**
 * A SQL string literal for `value` (standard_conforming_strings, the Postgres
 * default: only the quote character needs doubling). NUL cannot be stored in
 * Postgres text and is refused.
 */
export function literal(value: string): string {
  if (value.includes("\0")) throw new Error("NUL is not allowed in a SQL text value");
  return `'${value.replace(/'/g, "''")}'`;
}
