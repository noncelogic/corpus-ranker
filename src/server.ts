// Ranker service: an HTTP server exposing a health endpoint and the REST API
// of the frozen contract (contracts/openapi.json, TECH-STACK §1), as it grows.
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { capture, type ApiResponse } from "./api/capture.ts";
import { score } from "./api/score.ts";
import { topN } from "./api/top-n.ts";
import { loadConfig, type RankerConfig } from "./config.ts";
import { pgClient, type Db } from "./db/client.ts";
import { s3ObjectStore, type ObjectStore } from "./storage/object-store.ts";

export { loadConfig, type RankerConfig };

export interface ServerDeps {
  /** The ranker database (default: a pooled in-process client for config.databaseUrl, closed with the server). */
  db?: Db;
  /** Clock (default: system time). */
  now?: () => Date;
  /** Store for captured bytes (default: the S3-compatible store in config.objectStore). */
  store?: ObjectStore;
}

const ORIGINALS = /^\/v1\/corpora\/([^/?#]+)\/originals$/;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createServer(config: RankerConfig, deps: ServerDeps = {}): Server {
  const owned = deps.db ? undefined : pgClient(config.databaseUrl);
  const db = deps.db ?? owned!;
  const now = deps.now ?? (() => new Date());
  const store = deps.store ?? s3ObjectStore(config.objectStore);

  const route = async (req: IncomingMessage): Promise<ApiResponse> => {
    const path = new URL(req.url ?? "/", "http://ranker").pathname;
    if (req.method === "GET" && path === "/healthz") return { status: 200, body: { status: "ok", service: "ranker" } };
    const originals = ORIGINALS.exec(path);
    if (originals && req.method === "POST") {
      let corpusId: string;
      try {
        corpusId = decodeURIComponent(originals[1]!);
      } catch {
        return { status: 400, body: { error: "invalid_corpus_id", message: "corpus_id is not valid percent-encoding" } };
      }
      return capture(corpusId, await readBody(req), { db, now, store });
    }
    if (req.method === "POST" && path === "/v1/scores") return score(await readBody(req), { db, now });
    if (req.method === "POST" && path === "/v1/top-n") return topN(await readBody(req), { db, now });
    return { status: 404, body: { error: "not_found", message: `${req.method} ${path}` } };
  };

  const server = createHttpServer((req, res) => {
    route(req)
      .catch((err: unknown) => {
        console.error(err);
        return { status: 500, body: { error: "internal", message: "internal error" } };
      })
      .then(({ status, body }) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      });
  });
  if (owned) server.on("close", () => void owned.end());
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const server = createServer(config);
  server.listen(config.port, config.host, () => {
    console.log(`ranker listening on http://${config.host}:${config.port}`);
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => server.close(() => process.exit(0)));
  }
}
