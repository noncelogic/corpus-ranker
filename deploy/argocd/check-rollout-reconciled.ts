#!/usr/bin/env node
// Read back whether the Argo Rollouts controller reconciles the ranker's API
// Rollout (CR-M3-ROLLOUT-CHECK):
//
//   node deploy/argocd/check-rollout-reconciled.ts
//
// It reads, through kubectl:
//
//   - API discovery for argoproj.io/v1alpha1 (`kubectl get --raw`), and checks
//     the group version serves the Rollout kind (resource `rollouts`). Argo CD
//     alone serves argoproj.io too (Application, AppProject), so the group being
//     served is not enough;
//   - the Rollout ranker-api in namespace corpus-ranker (deploy/api.yaml), and
//     checks status.observedGeneration equals metadata.generation: the Rollouts
//     controller writes observedGeneration only when it has reconciled that
//     generation of the spec.
//
// Run estate-side with a kubeconfig that may get rollouts.argoproj.io in
// corpus-ranker. It reads discovery and the one Rollout only; it never writes
// and never reads a Secret or ConfigMap. Exit 0: both conditions hold, and the
// generation is printed. Exit 1: the failed condition is named on stderr. Exit
// 2: a read failed for another reason (unreachable, forbidden), or a usage
// error. Each read is one `kubectl get` of one object, so there is no paging.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const GROUP_VERSION = "argoproj.io/v1alpha1";
export const ROLLOUT = { name: "ranker-api", namespace: "corpus-ranker" };
const AT = `Rollout ${ROLLOUT.namespace}/${ROLLOUT.name}`;

export class ReadError extends Error {}

/** Run `kubectl` and parse its JSON; undefined when the object or path does not exist. */
function kubectl(args: string[]): unknown {
  const r = spawnSync("kubectl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  if (r.error) throw new ReadError(`cannot run kubectl: ${r.error.message}`);
  if (r.status !== 0) {
    const err = `${r.stderr ?? ""}${r.stdout ?? ""}`.trim();
    if (/\(NotFound\)/.test(err)) return undefined;
    throw new ReadError(`kubectl ${args.join(" ")} failed (exit ${r.status ?? r.signal}): ${err.split("\n")[0] ?? ""}`);
  }
  try {
    return JSON.parse(r.stdout) as unknown;
  } catch {
    throw new ReadError(`kubectl ${args.join(" ")} returned something other than JSON`);
  }
}

const isRecord = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Whether an APIResourceList (undefined when the group version is not served) serves the Rollout kind. */
export function servesRollout(discovery: unknown): boolean {
  if (discovery === undefined) return false;
  if (!isRecord(discovery) || !Array.isArray(discovery.resources)) {
    throw new ReadError(`discovery of ${GROUP_VERSION} returned no APIResourceList`);
  }
  return discovery.resources.some((r: unknown) => isRecord(r) && r.name === "rollouts" && r.kind === "Rollout");
}

/** A generation as an integer: Argo Rollouts writes status.observedGeneration as a string. */
function asGeneration(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
}

/** The failed condition for the Rollout (undefined when absent), or undefined when it is reconciled. */
export function rolloutGap(rollout: unknown): { gap?: string; generation?: number } {
  if (rollout === undefined) return { gap: `${AT}: absent` };
  if (!isRecord(rollout)) throw new ReadError(`kubectl get ${AT} returned no object`);
  const generation = asGeneration(rollout.metadata?.generation);
  if (generation === undefined) return { gap: `${AT}: reports no metadata.generation` };
  const raw = rollout.status?.observedGeneration;
  if (raw === undefined || raw === null || raw === "") {
    return { gap: `${AT}: reports no status.observedGeneration at metadata.generation ${generation}; the Rollouts controller has not reconciled it` };
  }
  const observed = asGeneration(raw);
  if (observed === undefined) return { gap: `${AT}: status.observedGeneration ${JSON.stringify(raw)} is not a generation` };
  if (observed !== generation) {
    const how = observed < generation ? "lags" : "differs from";
    return { gap: `${AT}: status.observedGeneration ${observed} ${how} metadata.generation ${generation}; the Rollouts controller has not reconciled the current spec` };
  }
  return { generation };
}

function main(argv: string[]): number {
  if (argv.length > 0) {
    process.stderr.write("usage: node deploy/argocd/check-rollout-reconciled.ts\n");
    return 2;
  }
  try {
    if (!servesRollout(kubectl(["get", "--raw", `/apis/${GROUP_VERSION}`]))) {
      process.stderr.write(`the Rollout kind is not served: ${GROUP_VERSION} has no rollouts resource (is the Argo Rollouts CRD installed?)\n`);
      return 1;
    }
    const { gap, generation } = rolloutGap(
      kubectl(["get", "rollouts.argoproj.io", ROLLOUT.name, "-n", ROLLOUT.namespace, "-o", "json"]),
    );
    if (gap !== undefined) {
      process.stderr.write(`${gap}\n`);
      return 1;
    }
    process.stdout.write(`${GROUP_VERSION} serves the Rollout kind\n`);
    process.stdout.write(`${AT}: status.observedGeneration ${generation} equals generation ${generation}; the Rollouts controller reconciled it\n`);
    return 0;
  } catch (err) {
    if (!(err instanceof ReadError)) throw err;
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
