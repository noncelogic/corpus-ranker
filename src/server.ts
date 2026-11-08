// Ranker service skeleton: an HTTP server exposing a health endpoint.
// The REST API (TECH-STACK §1) grows from here.
import { createServer as createHttpServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { loadConfig, type RankerConfig } from "./config.ts";

export { loadConfig, type RankerConfig };

export function createServer(_config: RankerConfig): Server {
  return createHttpServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "ranker" }));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not_found" }));
  });
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
