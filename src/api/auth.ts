// API key check for the REST API (TECH-STACK §9): a request authenticates
// with `Authorization: Bearer <key>`, where the key is one of the per-principal
// keys the service booted with (config.apiKeys, src/config.ts). Keys are
// compared in constant time; a refusal never names or echoes a key.
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { ApiResponse } from "./capture.ts";

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

/**
 * The principal whose key the request carries, or the contract's 401 Error
 * response when it carries no valid key. With no keys configured, every
 * request is refused (fail closed).
 */
export function authenticate(
  headers: IncomingHttpHeaders,
  apiKeys: ReadonlyMap<string, string>,
): { principal: string } | ApiResponse {
  const m = /^Bearer (\S+)$/.exec(headers.authorization ?? "");
  if (m) {
    const presented = digest(m[1]!);
    let principal: string | undefined;
    for (const [name, key] of apiKeys) {
      if (timingSafeEqual(presented, digest(key)) && principal === undefined) principal = name;
    }
    if (principal !== undefined) return { principal };
  }
  return { status: 401, body: { error: "unauthenticated", message: "a valid API key is required (Authorization: Bearer <key>)" } };
}
