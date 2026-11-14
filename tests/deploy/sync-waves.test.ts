// CR-D1-WAVES acceptance: the rendered manifests are ordered with Argo CD
// sync waves so that one full sync of an empty namespace applies every
// prerequisite before the resource that consumes it:
//   Namespace -> password generators -> ExternalSecrets, ConfigMaps
//   -> CNPG cluster (and database) -> ranker workloads.
//
// Argo CD orders a sync by phase (PreSync, Sync, PostSync) and, within a
// phase, by the `argocd.argoproj.io/sync-wave` annotation; a later wave only
// starts once the earlier ones are applied and healthy. So a resource's place
// in the sync is (phase, wave), and every reference must point strictly
// earlier.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderObjects, type K8sObject } from "./render.ts";

const WAVE = "argocd.argoproj.io/sync-wave";
const HOOK = "argocd.argoproj.io/hook";
const PHASES = ["PreSync", "Sync", "PostSync"] as const;

const id = (o: K8sObject): string => `${o.kind}/${o.metadata.name}`;
const isCnpg = (o: K8sObject): boolean => o.apiVersion.startsWith("postgresql.cnpg.io/");

/** Where a resource lands in one Argo sync: [phase index, wave]. */
function position(o: K8sObject): [number, number] {
  const annotations = o.metadata.annotations ?? {};
  const raw = annotations[WAVE];
  assert.ok(raw !== undefined, `${id(o)} carries no ${WAVE} annotation`);
  assert.match(String(raw), /^-?\d+$/, `${id(o)} has a non-integer sync wave ${raw}`);
  // Hooks may list several phases; the earliest one is when it first runs.
  const hooks = annotations[HOOK] ? String(annotations[HOOK]).split(",").map((h) => h.trim()) : ["Sync"];
  const phases = hooks.map((h) => PHASES.indexOf(h as (typeof PHASES)[number]));
  for (const [i, p] of phases.entries()) assert.ok(p >= 0, `${id(o)} has unsupported hook ${hooks[i]}`);
  return [Math.min(...phases), Number(raw)];
}

const before = (a: [number, number], b: [number, number]): boolean => a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);

type Ref = { kind: "Namespace" | "Secret" | "ConfigMap" | "Cluster" | "Generator"; name: string; via: string };

/** Every Namespace, Secret, ConfigMap, generator or CNPG cluster `obj` refers to. */
function references(obj: K8sObject, clusterNames: string[]): Ref[] {
  const refs: Ref[] = [];
  if (obj.metadata.namespace) refs.push({ kind: "Namespace", name: obj.metadata.namespace, via: "metadata.namespace" });
  const named = (v: unknown): string | undefined =>
    v && typeof v === "object" && typeof (v as { name?: unknown }).name === "string" ? (v as { name: string }).name : undefined;

  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((n, i) => walk(n, `${path}[${i}]`));
      return;
    }
    if (!node || typeof node !== "object") return;
    const map = node as Record<string, unknown>;
    // A container env var pointing at a CNPG Service (<cluster>-rw/-ro/-r).
    if (typeof map.name === "string" && typeof map.value === "string") {
      for (const c of clusterNames) {
        if (new RegExp(`^${c}-(rw|ro|r)(\\.|$)`).test(map.value)) refs.push({ kind: "Cluster", name: c, via: path });
      }
    }
    for (const [key, value] of Object.entries(map)) {
      const at = `${path}.${key}`;
      if (key === "metadata" && path === "") continue;
      if (["secretKeyRef", "secretRef", "passwordSecret", "secret"].includes(key) && named(value)) {
        refs.push({ kind: "Secret", name: named(value)!, via: at });
      } else if (key === "secretName" && typeof value === "string") {
        refs.push({ kind: "Secret", name: value, via: at });
      } else if (["configMapKeyRef", "configMapRef", "configMap"].includes(key) && named(value)) {
        refs.push({ kind: "ConfigMap", name: named(value)!, via: at });
      } else if ((key === "configMapRefs" || key === "secretRefs") && Array.isArray(value)) {
        for (const v of value) {
          if (named(v)) refs.push({ kind: key === "configMapRefs" ? "ConfigMap" : "Secret", name: named(v)!, via: at });
        }
      } else if (key === "generatorRef" && named(value)) {
        refs.push({ kind: "Generator", name: named(value)!, via: at });
      } else if (key === "cluster" && isCnpg(obj) && named(value)) {
        // e.g. a CNPG Database's spec.cluster.
        refs.push({ kind: "Cluster", name: named(value)!, via: at });
      }
      walk(value, at);
    }
  };
  walk(obj, "");
  return refs;
}

/** The rendered resources that satisfy `ref`: the object itself, or the ExternalSecret that materialises a Secret. */
function sources(ref: Ref, objects: K8sObject[]): K8sObject[] {
  switch (ref.kind) {
    case "Namespace":
      return objects.filter((o) => o.kind === "Namespace" && o.metadata.name === ref.name);
    case "ConfigMap":
      return objects.filter((o) => o.kind === "ConfigMap" && o.metadata.name === ref.name);
    case "Cluster":
      return objects.filter((o) => isCnpg(o) && o.kind === "Cluster" && o.metadata.name === ref.name);
    case "Generator":
      return objects.filter((o) => o.apiVersion.startsWith("generators.external-secrets.io/") && o.metadata.name === ref.name);
    case "Secret":
      return objects.filter(
        (o) =>
          (o.kind === "Secret" && o.metadata.name === ref.name) ||
          (o.kind === "ExternalSecret" && (o.spec?.target?.name ?? o.metadata.name) === ref.name),
      );
  }
}

test("in the rendered manifests every resource has a sync wave strictly later than each Namespace, Secret source, ConfigMap or CNPG resource it references", () => {
  const objects = renderObjects();
  assert.ok(objects.length > 0, "nothing rendered");
  const clusterNames = objects.filter((o) => isCnpg(o) && o.kind === "Cluster").map((o) => o.metadata.name);
  assert.ok(clusterNames.length > 0, "no CNPG Cluster rendered");

  let checked = 0;
  for (const obj of objects) {
    const at = position(obj);
    for (const ref of references(obj, clusterNames)) {
      const found = sources(ref, objects).filter((s) => s !== obj);
      if (found.length === 0 && ref.kind === "Namespace") continue; // only cluster-scoped objects lack one, and they set none
      assert.ok(found.length > 0, `${id(obj)} references ${ref.kind} ${ref.name} (${ref.via}) that nothing in the render provides`);
      for (const src of found) {
        assert.ok(
          before(position(src), at),
          `${id(obj)} (wave ${at.join("/")}) must sync after ${id(src)} (wave ${position(src).join("/")}), which it references via ${ref.via}`,
        );
        checked++;
      }
    }
  }
  assert.ok(checked > 0, "no references found to check");
});

test("the waves follow the deployment order: namespace, secrets and config, database, workloads", () => {
  const objects = renderObjects();
  const waveOf = (pred: (o: K8sObject) => boolean, label: string): number[] => {
    const ws = objects.filter(pred).map((o) => {
      const [phase, wave] = position(o);
      assert.equal(phase, PHASES.indexOf("Sync"), `${id(o)} must run in the Sync phase so its wave orders it`);
      return wave;
    });
    assert.ok(ws.length > 0, `no ${label} rendered`);
    return ws;
  };
  const ns = waveOf((o) => o.kind === "Namespace", "Namespace");
  const prereqs = waveOf(
    (o) => o.kind === "ExternalSecret" || o.kind === "ConfigMap" || o.apiVersion.startsWith("generators.external-secrets.io/"),
    "secret/config prerequisites",
  );
  const db = waveOf(isCnpg, "CNPG resources");
  // PostSync hooks (the ranker-db-check Job) run after every Sync-phase wave
  // by construction, so only Sync-phase workloads are ordered by wave here.
  const isPostSync = (o: K8sObject): boolean => position(o)[0] === PHASES.indexOf("PostSync");
  const workloads = waveOf((o) => ["Deployment", "StatefulSet", "Job", "CronJob"].includes(o.kind) && !isPostSync(o), "workloads");

  assert.ok(Math.max(...ns) < Math.min(...prereqs), "the namespace comes first");
  assert.ok(Math.max(...prereqs) < Math.min(...db), "secrets and ConfigMaps precede the database");
  assert.ok(Math.max(...db) < Math.min(...workloads), "the database precedes the ranker workloads");
});
