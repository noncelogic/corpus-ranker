// Shared namer for every Compose project the tests start: a fixed prefix plus
// a fresh random UUID. Never derive it from process.pid or the clock; those
// repeat across processes, pods sharing a Docker daemon, and time, and a
// collision makes one fixture reuse, then tear down, another's containers.
import { randomUUID } from "node:crypto";

/** A unique Compose project name (lowercase, valid for `docker compose -p`). */
export function composeProjectName(prefix: string): string {
  return `${prefix}${randomUUID()}`.toLowerCase();
}
