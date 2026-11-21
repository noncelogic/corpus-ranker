// Shared helpers for the deploy/ manifest tests: render the overlay with a
// local kustomize binary and read the rendered YAML without a YAML library
// (no new dependency; docs/EXTERNAL-REVIEW.md §3).
//
// Requires a kustomize binary: $KUSTOMIZE, `kustomize` on PATH, or
// `kubectl kustomize` (GitHub-hosted ubuntu runners ship both). Rendering is
// purely local; nothing here talks to a cluster.
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const deployDir = resolve(repoRoot, "deploy");

function tryRun(cmd: string, args: string[]): string | undefined {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export function kustomizeBuild(dir: string = deployDir): string {
  const candidates: Array<[string, string[]]> = [];
  if (process.env.KUSTOMIZE) candidates.push([process.env.KUSTOMIZE, ["build", dir]]);
  candidates.push(["kustomize", ["build", dir]], ["kubectl", ["kustomize", dir]]);
  for (const [cmd, args] of candidates) {
    const out = tryRun(cmd, args);
    if (out !== undefined) return out;
  }
  throw new Error("no kustomize found: install kustomize or kubectl, or set $KUSTOMIZE");
}

// The YAML reader lives in deploy/yaml.ts, shared with the estate checkers.
export { parseYamlDocs, type Yaml } from "../../deploy/yaml.ts";
import { parseYamlDocs } from "../../deploy/yaml.ts";

// ---------------------------------------------------------------------------
// Typed-enough access to rendered Kubernetes objects.

export interface K8sObject {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; annotations?: Record<string, string>; labels?: Record<string, string> };
  [key: string]: any;
}

let rendered: K8sObject[] | undefined;
export const renderObjects = (): K8sObject[] => (rendered ??= parseYamlDocs(kustomizeBuild()) as unknown as K8sObject[]);

export function findObject(kind: string, name: string): K8sObject {
  const obj = renderObjects().find((o) => o.kind === kind && o.metadata?.name === name);
  if (!obj) throw new Error(`rendered manifests have no ${kind}/${name}`);
  return obj;
}
