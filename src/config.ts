// Ranker service configuration, read from the environment.
// Defaults match the local Compose replica (docker-compose.yaml).

export interface RankerConfig {
  /** Host interface the HTTP API binds to. */
  host: string;
  /** Port the HTTP API listens on. */
  port: number;
  /** Postgres connection string for the ranker's own database (pgvector-enabled). */
  databaseUrl: string;
  /** S3-compatible object store holding content-addressed originals. */
  objectStore: {
    endpoint: string;
    bucket: string;
  };
}

type Env = Readonly<Record<string, string | undefined>>;

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`invalid port: ${raw}`);
  }
  return n;
}

export function loadConfig(env: Env = process.env): RankerConfig {
  return {
    host: env.RANKER_HOST ?? "127.0.0.1",
    port: parsePort(env.RANKER_PORT, 8080),
    databaseUrl: env.RANKER_DATABASE_URL ?? "postgres://ranker:ranker@127.0.0.1:5432/ranker",
    objectStore: {
      endpoint: env.RANKER_S3_ENDPOINT ?? "http://127.0.0.1:9000",
      bucket: env.RANKER_S3_BUCKET ?? "ranker-originals",
    },
  };
}
