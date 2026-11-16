// Ranker service configuration, read from the environment.
// Defaults match the local Compose replica (docker-compose.yaml).
// `loadServiceConfig` is the stricter boot-time read for the server itself:
// it takes no default for a secret (CR-D1-SECRETS).
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
    accessKeyId: string;
    secretAccessKey: string;
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
      accessKeyId: env.RANKER_S3_ACCESS_KEY_ID ?? "ranker",
      secretAccessKey: env.RANKER_S3_SECRET_ACCESS_KEY ?? "ranker-local-only",
    },
  };
}

export interface ServiceConfig extends RankerConfig {
  /** API key per agent principal (principal name -> key), TECH-STACK §9. */
  apiKeys: ReadonlyMap<string, string>;
}

/** The service cannot boot: names what is missing, never a secret value. */
export class BootConfigError extends Error {
  override name = "BootConfigError";
}

/**
 * Read the API key set from `dir`: one file per principal, named for it,
 * holding its key, as the `ranker-api-keys` Secret (synced from OpenBao
 * kv/corpus-ranker/api-keys) is mounted. Dot-entries are the Secret volume's
 * own bookkeeping (`..data`), not principals.
 */
function readApiKeys(dir: string, problems: string[]): Map<string, string> {
  const keys = new Map<string, string>();
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => !n.startsWith(".")).sort();
  } catch (err) {
    problems.push(`cannot read the API key directory RANKER_API_KEYS_DIR=${dir} (${(err as NodeJS.ErrnoException).code ?? "error"})`);
    return keys;
  }
  const owners = new Map<string, string>();
  for (const principal of names) {
    let key: string;
    try {
      key = readFileSync(join(dir, principal), "utf8").trim();
    } catch (err) {
      problems.push(`cannot read the API key of principal ${principal} (${(err as NodeJS.ErrnoException).code ?? "error"})`);
      continue;
    }
    if (key === "") {
      problems.push(`principal ${principal} has an empty API key`);
      continue;
    }
    const other = owners.get(key);
    if (other !== undefined) problems.push(`principals ${other} and ${principal} have the same API key`);
    owners.set(key, principal);
    keys.set(principal, key);
  }
  if (names.length === 0) problems.push(`no API keys in RANKER_API_KEYS_DIR=${dir}`);
  return keys;
}

/**
 * The configuration the server boots with. Unlike `loadConfig`, it refuses
 * (throws BootConfigError) when the API key set or the object-store
 * credentials are absent, rather than falling back to local defaults.
 */
export function loadServiceConfig(env: Env = process.env): ServiceConfig {
  const problems: string[] = [];
  for (const name of ["RANKER_S3_ACCESS_KEY_ID", "RANKER_S3_SECRET_ACCESS_KEY"] as const) {
    if (!env[name]) problems.push(`${name} is not set (object-store credentials)`);
  }
  const dir = env.RANKER_API_KEYS_DIR;
  const apiKeys = dir ? readApiKeys(dir, problems) : new Map<string, string>();
  if (!dir) problems.push("RANKER_API_KEYS_DIR is not set (the API key set)");
  if (problems.length > 0) {
    throw new BootConfigError(`ranker refuses to start:\n- ${problems.join("\n- ")}`);
  }
  return { ...loadConfig(env), apiKeys };
}
