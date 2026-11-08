// CR-M1-T1 acceptance: the one-command Compose replica boots Postgres with
// pgvector plus MinIO, in the deployment shape (TECH-STACK §2, §3, §5):
// a dedicated `ranker` database with the `vector` extension, and a
// dedicated `ranker-originals` bucket on an S3-compatible MinIO.
//
// Requires Docker with the Compose plugin. Each run uses its own Compose
// project name and free host ports, and tears everything down afterwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const composeFile = resolve(repoRoot, "docker-compose.yaml");

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      srv.close(() => (addr && typeof addr === "object" ? ok(addr.port) : fail(new Error("no port"))));
    });
  });
}

test("compose replica boots postgres with pgvector plus minio", { timeout: 600_000 }, async (t) => {
  const project = `crreplica${process.pid}${Date.now() % 100000}`;
  const env = {
    ...process.env,
    RANKER_PG_PORT: String(await freePort()),
    RANKER_MINIO_PORT: String(await freePort()),
    RANKER_MINIO_CONSOLE_PORT: String(await freePort()),
  };
  const compose = (...args: string[]): string =>
    execFileSync("docker", ["compose", "-f", composeFile, "-p", project, ...args], {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

  t.after(() => {
    try {
      compose("down", "-v", "--remove-orphans");
    } catch {
      /* best-effort teardown */
    }
  });

  // The one command.
  compose("up", "-d", "--wait", "--wait-timeout", "300");

  // Postgres: dedicated ranker database, pgvector installed and usable.
  const psql = (sql: string): string =>
    compose("exec", "-T", "postgres", "psql", "-U", "ranker", "-d", "ranker", "-tAc", sql).trim();
  assert.equal(psql("select current_database()"), "ranker");
  const extVersion = psql("select extversion from pg_extension where extname = 'vector'");
  assert.match(extVersion, /^\d+\.\d+/, "vector extension must be installed in the ranker database");
  assert.equal(psql("select '[1,2,3]'::vector <-> '[1,2,4]'::vector"), "1");
  assert.equal(psql("select ('[1,0]'::vector <=> '[0,1]'::vector)::int"), "1");

  // MinIO: S3 API live on the published port, ranker bucket provisioned.
  const s3 = `http://127.0.0.1:${env.RANKER_MINIO_PORT}`;
  const live = await fetch(`${s3}/minio/health/live`);
  assert.equal(live.status, 200, "minio liveness endpoint");
  const ready = await fetch(`${s3}/minio/health/ready`);
  assert.equal(ready.status, 200, "minio readiness endpoint");

  // Anonymous access to the bucket is refused (private by default).
  const anon = await fetch(`${s3}/ranker-originals`, { method: "HEAD" });
  assert.equal(anon.status, 403, "ranker-originals must not be anonymously readable");

  // Authenticated check: the bucket exists and accepts a write/read round trip.
  const mc = (...args: string[]): string => compose("exec", "-T", "minio", "mc", ...args).trim();
  const buckets = mc("ls", "replica").split("\n").map((l) => l.trim().split(/\s+/).pop());
  assert.ok(buckets.includes("ranker-originals/"), `bucket list: ${JSON.stringify(buckets)}`);
  compose("exec", "-T", "minio", "sh", "-c", "printf replica-probe | mc pipe replica/ranker-originals/probe.txt");
  assert.equal(mc("cat", "replica/ranker-originals/probe.txt"), "replica-probe");
});
