// CR-M1-T1 acceptance: the one-command Compose replica boots Postgres with
// pgvector plus MinIO, in the deployment shape (TECH-STACK §2, §3, §5):
// a dedicated `ranker` database with the `vector` extension, and a
// dedicated `ranker-originals` bucket on an S3-compatible MinIO.
//
// Requires Docker with the Compose plugin. Each run uses its own Compose
// project name, has Docker allocate host ports atomically at bind time (port
// 0) and discovers them via `docker compose port`, and tears everything down
// afterwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const composeFile = resolve(repoRoot, "docker-compose.yaml");

function assertPostgresHealthcheckGatesOnInitializedRanker(): void {
  // `up --wait` is only as good as the healthcheck it waits on. A socket
  // pg_isready can pass against the entrypoint's temporary init server
  // (unix socket only, before the ranker db and vector exist, before the
  // final restart), so that race is timing-dependent and cannot be
  // reproduced reliably; assert the healthcheck's shape instead, and the
  // test queries ranker once, immediately after `up --wait` returns.
  const config = JSON.parse(
    execFileSync("docker", ["compose", "-f", composeFile, "config", "--format", "json"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  ) as { services: { postgres: { healthcheck?: { test?: string[]; disable?: boolean } } } };
  const hc = config.services.postgres.healthcheck;
  assert.ok(hc?.test && !hc.disable, "postgres must declare a healthcheck");
  const [kind, ...rest] = hc.test;
  assert.ok(kind === "CMD-SHELL" || kind === "CMD", `healthcheck kind ${kind}`);
  const cmd = rest.join(" ");
  assert.doesNotMatch(cmd, /pg_isready/, "pg_isready only proves a server accepts connections, not init is done");
  assert.match(cmd, /\bpsql\b/, "healthcheck must run a query");
  assert.match(cmd, /(?:-h|--host)[ =]\s*(?:127\.0\.0\.1|localhost)\b/, "healthcheck must connect over TCP");
  assert.match(cmd, /(?:-d|--dbname)[ =]\s*ranker\b/, "healthcheck must connect to the ranker database");
  assert.match(cmd, /from\s+pg_extension\b/i, "healthcheck must read pg_extension");
  assert.match(cmd, /extname\s*=\s*'vector'/, "healthcheck must look for the vector extension");
  assert.match(cmd, /grep\s+-qx\s+vector\b/, "healthcheck must fail unless the query returns vector");
}

test("compose up --wait returns only when the ranker database answers a TCP query and pg_extension lists vector", { timeout: 600_000 }, async (t) => {
  assertPostgresHealthcheckGatesOnInitializedRanker();

  const project = `crreplica${process.pid}${Date.now() % 100000}`;
  const env = {
    ...process.env,
    // 0 = Docker picks a free host port when it binds; no pre-probe race.
    RANKER_PG_PORT: "0",
    RANKER_MINIO_PORT: "0",
    RANKER_MINIO_CONSOLE_PORT: "0",
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

  // Discover the host ports Docker actually bound.
  const hostPort = (service: string, port: number): number => {
    const out = compose("port", service, String(port)).trim();
    const m = /:(\d+)$/.exec(out);
    assert.ok(m, `no published port for ${service}:${port}: ${JSON.stringify(out)}`);
    const n = Number(m[1]);
    assert.ok(n > 0, `${service}:${port} published on ${n}`);
    return n;
  };
  const minioPort = hostPort("minio", 9000);
  hostPort("postgres", 5432);

  // Postgres: queries go over TCP, which only the final (post-init) server
  // listens on. `up --wait` must be the whole readiness signal: query the
  // ranker database once, right now, with no retry and no sleep.
  const psql = (sql: string): string =>
    compose(
      "exec", "-T", "-e", "PGPASSWORD=ranker", "postgres",
      "psql", "-h", "127.0.0.1", "-U", "ranker", "-d", "ranker", "-v", "ON_ERROR_STOP=1", "-tAc", sql,
    ).trim();
  assert.equal(
    psql("select extname from pg_extension where extname = 'vector'"),
    "vector",
    "ranker database must answer over TCP with vector installed as soon as up --wait returns",
  );
  assert.equal(psql("select current_database()"), "ranker");
  const extVersion = psql("select extversion from pg_extension where extname = 'vector'");
  assert.match(extVersion, /^\d+\.\d+/, "vector extension must be installed in the ranker database");
  assert.equal(psql("select '[1,2,3]'::vector <-> '[1,2,4]'::vector"), "1");
  assert.equal(psql("select ('[1,0]'::vector <=> '[0,1]'::vector)::int"), "1");

  // MinIO: S3 API live on the published port, ranker bucket provisioned.
  const s3 = `http://127.0.0.1:${minioPort}`;
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
