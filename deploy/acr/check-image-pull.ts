#!/usr/bin/env node
// Read back which ranker image the estate runs and check it is the pinned
// estate-registry image (deploy step CRANK-212, INTENTS I21 ACR move):
//
//   node deploy/acr/check-image-pull.ts
//
// It reads, through kubectl, the corpus-ranker Argo CD Application (namespace
// argocd) and the pods of the API Deployment (ranker-api) and of the migration
// Job (ranker-db-migrate) in namespace corpus-ranker, selected by their pod
// template label app.kubernetes.io/name, and checks:
//
//   - the Application's kustomize source has exactly one image entry, and it
//     pins noncelogicci.azurecr.io/corpus-ranker to a sha-<commit> tag (the
//     tag .github/workflows/publish.yml pushes), either as
//     `<image>:sha-<commit>` or `<image>=<image>:sha-<commit>`; an override to
//     another registry (the ghcr.io bridge) or a moving tag is a mismatch;
//   - the Application carries no kustomize patch on an ExternalSecret (the
//     ranker-ghcr-pull bridge patch): deploy/ names its own ACR pull Secret,
//     ranker-registry-pull, so no patch is needed;
//   - every API and migration pod ran that pinned image: the ranker container
//     (api; the migrations init container) and any other container naming a
//     corpus-ranker image, by the image in the pod spec and the image the
//     kubelet reports in the container status. The kubelet fills status.image
//     even for a container still waiting (ImagePullBackOff, ErrImagePull), so
//     a container counts as having run only with execution evidence -- a
//     running or terminated state, or a terminated lastState, carrying a
//     containerID -- and an image identity: a non-empty status imageID that
//     is a sha256 digest of the registry image. A container that never ran is
//     named with its waiting reason. A workload with no pod left to read is a
//     mismatch too: nothing shows what it ran.
//
// Run estate-side with a kubeconfig that may get Applications in argocd and
// pods in corpus-ranker. It reads object specs and statuses only, never a
// Secret. Exit 0: everything matches, and the pinned image and each pod's
// image digest are printed. Exit 1: each mismatch is named on stderr, one per
// line. Exit 2: a read failed for another reason (unreachable, forbidden), or a
// usage error.
//
// Each read is one `kubectl get`; kubectl itself chunks list reads, so this
// script runs no paging loop.
import { spawnSync } from "node:child_process";

const REGISTRY_IMAGE = "noncelogicci.azurecr.io/corpus-ranker";
const APP = { name: "corpus-ranker", namespace: "argocd" };
const NAMESPACE = "corpus-ranker";
/** Each checked workload: its pods' label value and the container that runs the ranker image. */
const WORKLOADS = [
  { id: "Deployment/ranker-api", label: "ranker-api", container: { name: "api", init: false } },
  { id: "Job/ranker-db-migrate", label: "ranker-db-migrate", container: { name: "migrations", init: true } },
] as const;

const SHA_TAG = /^sha-[0-9a-f]{40}$/;
/** Any corpus-ranker image reference, from whichever registry. */
const isAnyRankerImage = (image: string) => /(^|\/)corpus-ranker(?:[:@]|$)/.test(image);
const quote = (v: unknown) => JSON.stringify(v);

class ReadError extends Error {}

/** Run `kubectl` and parse its JSON; undefined when the object does not exist. */
function kubectl(args: string[]): unknown {
  const r = spawnSync("kubectl", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
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

/** The kustomize blocks of an Application's source or sources. */
function kustomizeBlocks(app: Record<string, any>): Array<Record<string, any>> {
  const sources = [app.spec?.source, ...(Array.isArray(app.spec?.sources) ? app.spec.sources : [])].filter(isRecord);
  return sources.map((s) => s.kustomize).filter(isRecord);
}

/**
 * Check the Application's image entries and patches. Returns the pinned
 * image when its one image entry pins the registry image to a sha tag.
 */
function checkApplication(app: Record<string, any>, mismatches: string[]): string | undefined {
  const at = `Application ${APP.namespace}/${APP.name}`;
  const blocks = kustomizeBlocks(app);

  const images: string[] = blocks.flatMap((k) => (Array.isArray(k.images) ? k.images.map(String) : []));
  let pinned: string | undefined;
  if (images.length === 0) {
    mismatches.push(`${at}: no image entry; expected one pinning ${REGISTRY_IMAGE}:sha-<commit>`);
  } else if (images.length > 1) {
    mismatches.push(`${at}: ${images.length} image entries ${quote(images)}; expected only one pinning ${REGISTRY_IMAGE}:sha-<commit>`);
  }
  for (const entry of images) {
    // Argo CD's kustomize image form: [<name>=]<newName>[:<tag>][@<digest>].
    const eq = entry.indexOf("=");
    const name = eq < 0 ? undefined : entry.slice(0, eq);
    const ref = eq < 0 ? entry : entry.slice(eq + 1);
    const m = /^(.*?)(?::([^:/@]+))?(?:@(.+))?$/.exec(ref)!;
    const [, repo, tag, digest] = m;
    const problems: string[] = [];
    if (name !== undefined && name !== REGISTRY_IMAGE) problems.push(`overrides ${quote(name)}, not ${REGISTRY_IMAGE}`);
    if (repo !== REGISTRY_IMAGE) problems.push(`pulls ${quote(repo)}, not ${REGISTRY_IMAGE}`);
    if (tag === undefined || !SHA_TAG.test(tag)) problems.push(`tag ${quote(tag ?? null)} is not a sha-<commit> tag`);
    if (digest !== undefined) problems.push(`adds digest ${quote(digest)}; pin the sha-<commit> tag alone`);
    if (problems.length > 0) {
      mismatches.push(`${at}: image entry ${quote(entry)} ${problems.join("; ")}`);
    } else if (images.length === 1) {
      pinned = `${REGISTRY_IMAGE}:${tag}`;
    }
  }

  // Kustomize patches (and the older patchesStrategicMerge / patchesJson6902 forms) on an ExternalSecret.
  const patches: Array<{ target?: Record<string, any>; text: string }> = [];
  for (const k of blocks) {
    for (const p of Array.isArray(k.patches) ? k.patches : []) {
      patches.push({ target: isRecord(p) && isRecord(p.target) ? p.target : undefined, text: isRecord(p) ? String(p.patch ?? p.path ?? "") : String(p) });
    }
    for (const p of Array.isArray(k.patchesStrategicMerge) ? k.patchesStrategicMerge : []) patches.push({ text: String(p) });
    for (const p of Array.isArray(k.patchesJson6902) ? k.patchesJson6902 : []) {
      patches.push({ target: isRecord(p) && isRecord(p.target) ? p.target : undefined, text: isRecord(p) ? String(p.patch ?? p.path ?? "") : String(p) });
    }
  }
  for (const p of patches) {
    const targetsKind = p.target?.kind === "ExternalSecret";
    const inText = /^\s*kind:\s*["']?ExternalSecret["']?\s*$/m.test(p.text) || /"kind"\s*:\s*"ExternalSecret"/.test(p.text);
    if (!targetsKind && !inText) continue;
    const textName = /^\s*name:\s*["']?([\w.-]+)/m.exec(p.text)?.[1];
    const target = `ExternalSecret${p.target?.name ? `/${p.target.name}` : textName ? `/${textName}` : ""}`;
    const bridge = /ranker-ghcr-pull|ghcr-pull/.test(p.text) ? " (the ranker-ghcr-pull bridge)" : "";
    mismatches.push(`${at}: carries a patch on ${target}${bridge}; deploy/ names its own pull Secret, so delete it`);
  }
  return pinned;
}

interface ContainerRun {
  name: string;
  init: boolean;
  specImage?: string;
  statusImage?: string;
  imageID?: string;
  /** The container status, when the kubelet reported one. */
  status?: Record<string, any>;
}

/**
 * Where the container status shows the container was started, or undefined.
 * Kubernetes ContainerStatus: state.running (with the status's containerID),
 * state.terminated or lastState.terminated (each with its own containerID).
 */
function executionEvidence(status: Record<string, any>): string | undefined {
  const has = (v: unknown) => typeof v === "string" && v !== "";
  const state = isRecord(status.state) ? status.state : {};
  const last = isRecord(status.lastState) ? status.lastState : {};
  const exit = (t: Record<string, any>) => `exit ${quote(t.exitCode ?? null)}${t.reason ? ` ${t.reason}` : ""}`;
  if (isRecord(state.running) && has(status.containerID)) return `running since ${state.running.startedAt ?? "?"}`;
  if (isRecord(state.terminated) && (has(state.terminated.containerID) || has(status.containerID))) return `terminated, ${exit(state.terminated)}`;
  if (isRecord(last.terminated) && has(last.terminated.containerID)) return `last terminated, ${exit(last.terminated)}`;
  return undefined;
}

/** Why a container status shows no run: its waiting reason, when there is one. */
function notRunReason(status: Record<string, any>): string {
  const w = isRecord(status.state) && isRecord(status.state.waiting) ? status.state.waiting : undefined;
  if (w) return `waiting${w.reason ? ` (${w.reason}${w.message ? `: ${String(w.message).split("\n")[0]}` : ""})` : ""}`;
  return "no running or terminated state with a containerID";
}

/** The problem with a status imageID as identity of the registry image, if any. */
function imageIdProblem(imageID: string | undefined): string | undefined {
  if (imageID === undefined || imageID === "") return "reports no imageID";
  const id = imageID.replace(/^[a-z-]+:\/\//, ""); // docker-pullable://, containerd's bare form
  const m = /^(?:(.+)@)?(sha256:[0-9a-f]{64})$/.exec(id);
  if (!m) return `imageID ${quote(imageID)} is not a sha256 digest`;
  if (m[1] !== undefined && m[1] !== REGISTRY_IMAGE) return `imageID ${quote(imageID)} is not a digest of ${REGISTRY_IMAGE}`;
  return undefined;
}

function containersOf(pod: Record<string, any>): ContainerRun[] {
  const out: ContainerRun[] = [];
  for (const [init, specKey, statusKey] of [
    [true, "initContainers", "initContainerStatuses"],
    [false, "containers", "containerStatuses"],
  ] as const) {
    const statuses: Array<Record<string, any>> = Array.isArray(pod.status?.[statusKey]) ? pod.status[statusKey] : [];
    for (const c of Array.isArray(pod.spec?.[specKey]) ? (pod.spec[specKey] as Array<Record<string, any>>) : []) {
      const s = statuses.find((x) => x.name === c.name);
      out.push({ name: String(c.name), init, specImage: c.image, statusImage: s?.image, imageID: s?.imageID, status: s });
    }
  }
  return out;
}

function checkPods(workload: (typeof WORKLOADS)[number], list: unknown, pinned: string | undefined, mismatches: string[], ok: string[]) {
  const items = isRecord(list) && Array.isArray(list.items) ? (list.items as unknown[]).filter(isRecord) : undefined;
  if (items === undefined) throw new ReadError(`kubectl get pods for ${workload.id} returned no pod list`);
  if (items.length === 0) {
    mismatches.push(`${workload.id}: no pod found (label app.kubernetes.io/name=${workload.label} in ${NAMESPACE}); nothing shows what it ran`);
    return;
  }
  const want = pinned ?? `${REGISTRY_IMAGE}:sha-<commit>`;
  for (const pod of items) {
    const podName = String(pod.metadata?.name ?? "<unnamed>");
    const containers = containersOf(pod);
    const ranker = containers.find((c) => c.name === workload.container.name && c.init === workload.container.init);
    if (!ranker) {
      mismatches.push(`${workload.id}: pod ${podName} runs no ${workload.container.init ? "init " : ""}container ${workload.container.name}`);
    }
    const checked = containers.filter((c) => c === ranker || isAnyRankerImage(c.specImage ?? "") || isAnyRankerImage(c.statusImage ?? ""));
    for (const c of checked) {
      const at = `${workload.id}: pod ${podName} container ${c.name}`;
      const ran = c.statusImage ?? c.specImage;
      if (c.statusImage === undefined) {
        mismatches.push(`${at} has not run (no container status); spec image ${quote(c.specImage ?? null)}, expected ${want}`);
        continue;
      }
      const evidence = executionEvidence(c.status!);
      if (evidence === undefined) {
        mismatches.push(`${at} never ran: ${notRunReason(c.status!)}; status image ${quote(c.statusImage)}, imageID ${quote(c.imageID ?? null)}, expected ${want}`);
        continue;
      }
      const bad = [c.specImage, c.statusImage].filter((i) => pinned === undefined || i !== pinned);
      if (bad.length > 0) {
        const detail = c.specImage !== c.statusImage ? ` (spec ${quote(c.specImage ?? null)}, status ${quote(c.statusImage)})` : "";
        mismatches.push(`${at} ran ${ran}${detail}, not ${want}`);
        continue;
      }
      const idProblem = imageIdProblem(c.imageID);
      if (idProblem !== undefined) {
        mismatches.push(`${at} ran ${ran} (${evidence}) but ${idProblem}; nothing identifies the image it ran`);
        continue;
      }
      ok.push(`${workload.id}: pod ${podName} container ${c.name} ran ${ran} (${c.imageID}; ${evidence})`);
    }
  }
}

function main(argv: string[]): number {
  if (argv.length > 0) {
    process.stderr.write("usage: node deploy/acr/check-image-pull.ts\n");
    return 2;
  }
  const mismatches: string[] = [];
  const ok: string[] = [];
  try {
    const app = kubectl(["get", "applications.argoproj.io", APP.name, "-n", APP.namespace, "-o", "json"]);
    let pinned: string | undefined;
    if (app === undefined) {
      mismatches.push(`Application ${APP.namespace}/${APP.name}: absent`);
    } else if (!isRecord(app)) {
      throw new ReadError(`kubectl get Application ${APP.namespace}/${APP.name} returned no object`);
    } else {
      pinned = checkApplication(app, mismatches);
      if (pinned) ok.push(`Application ${APP.namespace}/${APP.name} pins ${pinned} and carries no ExternalSecret patch`);
    }
    for (const w of WORKLOADS) {
      const list = kubectl(["get", "pods", "-n", NAMESPACE, "-l", `app.kubernetes.io/name=${w.label}`, "-o", "json"]);
      checkPods(w, list, pinned, mismatches, ok);
    }
  } catch (err) {
    if (!(err instanceof ReadError)) throw err;
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  if (mismatches.length > 0) {
    for (const m of mismatches) process.stderr.write(`${m}\n`);
    process.stderr.write(`${mismatches.length} mismatch(es) with the pinned ${REGISTRY_IMAGE} sha tag\n`);
    return 1;
  }
  for (const line of ok) process.stdout.write(`${line}\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
