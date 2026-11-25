#!/usr/bin/env node
// Check that the Argo Rollouts controller reconciles the ranker's API Rollout
// (CR-M3-ROLLOUT-CHECK):
//
//   node deploy/argocd/check-rollout-reconciled.ts
//
// It reads, through kubectl, two things and nothing else:
//
//   - API discovery for argoproj.io/v1alpha1 (`kubectl get --raw
//     /apis/argoproj.io/v1alpha1`): the cluster must serve the Rollout kind
//     (resource rollouts, kind Rollout), which the Argo Rollouts CRD installs;
//   - the Rollout ranker-api in namespace corpus-ranker (deploy/api.yaml): its
//     status.observedGeneration must equal its metadata.generation. The Argo
//     Rollouts controller writes observedGeneration when it reconciles a spec
//     generation, so equality shows the controller has reconciled the
//     Rollout's current spec; a missing or lagging value shows it has not.
//
// Run estate-side with a kubeconfig that may read API discovery and get
// rollouts.argoproj.io in corpus-ranker. It changes nothing and reads no
// Secret or ConfigMap. Exit 0: the Rollout is reconciled, printed on stdout.
// Exit 1: the failed condition is named on stderr. Exit 2: a read failed for
// another reason (unreachable, forbidden), or a usage error.
//
// Each read is one `kubectl get` of one object, so there is no paging.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const GROUP_VERSION = "argoproj.io/v1alpha1";
export const ROLLOUT = { name: "ranker-api", namespace: "corpus-ranker" };
const AT = `Rollout ${ROLLOUT.namespace}/${ROLLOUT.name}`;

export class ReadError extends Error {}

const isRecord = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const quote = (v: unknown) => JSON.stringify(v);

/** Run `kubectl` and parse its JSON; undefined when the server answers NotFound. */
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

/** A generation as an integer: a number, or the decimal string older controllers write. */
function generationOf(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isInteger(v)) return v;
  if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  return undefined;
}

export interface RolloutResult {
  /** The failed condition, when one failed. */
  failure?: string;
  /** What shows the Rollout reconciled, when nothing failed. */
  ok?: string;
}

/**
 * Judge the discovery read (an APIResourceList, or undefined when the group
 * version is not served) and the Rollout read (undefined when absent; not
 * read at all when the kind is not served).
 */
export function checkRolloutReconciled(discovery: unknown, readRollout: () => unknown): RolloutResult {
  if (discovery !== undefined && !(isRecord(discovery) && Array.isArray(discovery.resources))) {
    throw new ReadError(`kubectl get --raw /apis/${GROUP_VERSION} returned no APIResourceList`);
  }
  const served = discovery !== undefined && (discovery.resources as unknown[]).some((r) => isRecord(r) && r.name === "rollouts" && r.kind === "Rollout");
  if (!served) {
    return { failure: `the Rollout kind (rollouts.argoproj.io) is not served at ${GROUP_VERSION}; the Argo Rollouts CRD is not installed` };
  }

  const rollout = readRollout();
  if (rollout === undefined) return { failure: `${AT}: absent` };
  if (!isRecord(rollout)) throw new ReadError(`kubectl get rollouts.argoproj.io ${ROLLOUT.name} returned no object`);

  const generation = generationOf(rollout.metadata?.generation);
  if (generation === undefined) return { failure: `${AT}: metadata.generation ${quote(rollout.metadata?.generation ?? null)} is not a generation` };
  const rawObserved = rollout.status?.observedGeneration;
  if (rawObserved === undefined || rawObserved === null || rawObserved === "") {
    return { failure: `${AT}: no status.observedGeneration at metadata.generation ${generation}; the Argo Rollouts controller has not reconciled it` };
  }
  const observed = generationOf(rawObserved);
  if (observed === undefined) return { failure: `${AT}: status.observedGeneration ${quote(rawObserved)} is not a generation` };
  if (observed < generation) {
    return { failure: `${AT}: status.observedGeneration ${observed} lags metadata.generation ${generation}; the Argo Rollouts controller has not reconciled its current spec` };
  }
  if (observed !== generation) {
    return { failure: `${AT}: status.observedGeneration ${observed} does not equal metadata.generation ${generation}` };
  }
  return { ok: `${AT}: observedGeneration ${observed} = generation ${generation}; reconciled by the Argo Rollouts controller` };
}

function main(argv: string[]): number {
  if (argv.length > 0) {
    process.stderr.write("usage: node deploy/argocd/check-rollout-reconciled.ts\n");
    return 2;
  }
  let result: RolloutResult;
  try {
    const discovery = kubectl(["get", "--raw", `/apis/${GROUP_VERSION}`]);
    result = checkRolloutReconciled(discovery, () =>
      kubectl(["get", "rollouts.argoproj.io", ROLLOUT.name, "-n", ROLLOUT.namespace, "-o", "json"]),
    );
  } catch (err) {
    if (!(err instanceof ReadError)) throw err;
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  if (result.failure !== undefined) {
    process.stderr.write(`${result.failure}\n`);
    return 1;
  }
  process.stdout.write(`${result.ok}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
