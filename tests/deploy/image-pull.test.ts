// CR-D1-PULL acceptance: every rendered ranker workload references the
// ghcr.io/noncelogic/corpus-ranker image and an imagePullSecret that an
// ExternalSecret syncs from OpenBao, so the estate can fetch the (private)
// ranker image from GHCR.
//
// A "ranker workload" is any pod-bearing object whose pod template runs the
// ranker image (in a container or an init container). The API Deployment
// and the migration Job must be among them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderObjects, type K8sObject } from "./render.ts";

const RANKER_IMAGE = "ghcr.io/noncelogic/corpus-ranker";
const NAMESPACE = "corpus-ranker";
const WAVE = "argocd.argoproj.io/sync-wave";

interface Container {
  name?: string;
  image?: string;
}

/** The pod spec of a workload object, or undefined for non-workloads. */
function podSpec(o: K8sObject): Record<string, any> | undefined {
  switch (o.kind) {
    case "Deployment":
    case "StatefulSet":
    case "DaemonSet":
    case "ReplicaSet":
    case "Job":
      return o.spec?.template?.spec;
    case "CronJob":
      return o.spec?.jobTemplate?.spec?.template?.spec;
    case "Pod":
      return o.spec;
    default:
      return undefined;
  }
}

const imagesOf = (spec: Record<string, any>): string[] =>
  [...((spec.initContainers ?? []) as Container[]), ...((spec.containers ?? []) as Container[])].map((c) => c.image ?? "");

/** True when `image` is the ranker image, by tag or digest (or bare). */
const isRankerImage = (image: string): boolean => image === RANKER_IMAGE || /^ghcr\.io\/noncelogic\/corpus-ranker[:@]/.test(image);

test("every rendered ranker workload references the ghcr.io/noncelogic/corpus-ranker image and an imagePullSecret that an ExternalSecret syncs from OpenBao", () => {
  const objects = renderObjects();

  const workloads = objects.filter((o) => {
    const spec = podSpec(o);
    return spec !== undefined && imagesOf(spec).some(isRankerImage);
  });
  const ids = workloads.map((o) => `${o.kind}/${o.metadata.name}`);
  for (const expected of ["Deployment/ranker-api", "Job/ranker-db-migrate"]) {
    assert.ok(ids.includes(expected), `${expected} must run the ranker image ${RANKER_IMAGE}; ranker workloads: ${JSON.stringify(ids)}`);
  }

  for (const w of workloads) {
    const id = `${w.kind}/${w.metadata.name}`;
    const spec = podSpec(w)!;

    // The ranker image is the one published by .github/workflows/publish.yml.
    for (const image of imagesOf(spec).filter((i) => i.startsWith("ghcr.io/noncelogic/"))) {
      assert.match(image, /^ghcr\.io\/noncelogic\/corpus-ranker[:@]/, `${id} pulls ${image}, not a pinned ${RANKER_IMAGE}`);
    }

    const pullSecrets = ((spec.imagePullSecrets ?? []) as Array<{ name?: string }>).map((s) => s.name).filter((n): n is string => !!n);
    assert.ok(pullSecrets.length > 0, `${id} runs ${RANKER_IMAGE} but lists no imagePullSecrets`);

    for (const secretName of pullSecrets) {
      const syncs = objects.filter((o) => o.kind === "ExternalSecret" && (o.spec?.target?.name ?? o.metadata.name) === secretName);
      assert.equal(syncs.length, 1, `${id}: exactly one ExternalSecret must materialise pull secret ${secretName}`);
      const es = syncs[0]!;

      assert.equal(es.metadata.namespace, NAMESPACE, `ExternalSecret/${es.metadata.name} must sync into namespace ${NAMESPACE}`);
      assert.equal(w.metadata.namespace, NAMESPACE, `${id} must run in namespace ${NAMESPACE}`);

      // Synced from OpenBao, not generated in-cluster.
      assert.deepEqual(
        { kind: es.spec?.secretStoreRef?.kind, name: es.spec?.secretStoreRef?.name },
        { kind: "ClusterSecretStore", name: "openbao" },
        `ExternalSecret/${es.metadata.name} must read from the OpenBao ClusterSecretStore`,
      );
      const remoteKeys = [
        ...((es.spec?.data ?? []) as Array<{ remoteRef?: { key?: string } }>).map((d) => d.remoteRef?.key),
        ...((es.spec?.dataFrom ?? []) as Array<{ extract?: { key?: string }; sourceRef?: unknown }>).map((d) => {
          assert.equal(d.sourceRef, undefined, `ExternalSecret/${es.metadata.name} must not draw on a generator`);
          return d.extract?.key;
        }),
      ];
      assert.ok(remoteKeys.length > 0, `ExternalSecret/${es.metadata.name} reads no OpenBao key`);
      for (const key of remoteKeys) {
        assert.ok(typeof key === "string" && key.startsWith("corpus-ranker/"), `ExternalSecret/${es.metadata.name} reads ${key}, outside corpus-ranker/`);
      }

      // A registry credential the kubelet accepts.
      assert.equal(es.spec?.target?.template?.type, "kubernetes.io/dockerconfigjson", `pull secret ${secretName} must be of type kubernetes.io/dockerconfigjson`);
      assert.ok(
        typeof es.spec?.target?.template?.data?.[".dockerconfigjson"] === "string",
        `pull secret ${secretName} must carry a .dockerconfigjson key`,
      );

      // The secret exists before the workload that pulls with it.
      const esWave = Number(es.metadata.annotations?.[WAVE]);
      const wWave = Number(w.metadata.annotations?.[WAVE]);
      assert.ok(Number.isInteger(esWave) && Number.isInteger(wWave), `${id} and ExternalSecret/${es.metadata.name} need sync waves`);
      assert.ok(esWave < wWave, `ExternalSecret/${es.metadata.name} (wave ${esWave}) must sync before ${id} (wave ${wWave})`);
    }
  }
});
