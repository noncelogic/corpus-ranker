// CR-D1-PROMOTE acceptance, as amended by CR-ARGO-APP-OUT: the rendered
// overlay declares no Argo CD Application (the estate one tracks deploy/ on
// aks-obs-01), and the ranker API runs as an Argo Rollouts blue/green
// Rollout whose promotion waits on the readiness probe -- GET /readyz, which
// answers only while both the database and the object store do
// (src/api/readiness.ts, tests/api/readiness.test.ts).
//
// Requires a kustomize binary ($KUSTOMIZE, `kustomize`, or `kubectl
// kustomize`); rendering is purely local, nothing here talks to a cluster.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_READINESS_TIMEOUT_MS } from "../../src/api/readiness.ts";
import { findObject, renderObjects, type K8sObject } from "./render.ts";

const NAMESPACE = "corpus-ranker";
const WAVE = "argocd.argoproj.io/sync-wave";

const wave = (o: K8sObject): number => Number(o.metadata.annotations?.[WAVE]);

// CR-ARGO-APP-OUT: the overlay renders no Argo CD Application. The one
// definition of argocd/corpus-ranker is the estate Application (meta-harness
// devops/aks/corpus-ranker-argo/application.yaml: AppProject corpus-ranker,
// prune off, the image pin and the OpenBao Job patches), which syncs this
// overlay at targetRevision main. AppProject corpus-ranker permits only
// namespace corpus-ranker, so every rendered namespaced object targets it; an
// Application rendered here would land in namespace argocd and, if admitted,
// replace the estate spec. deploy/acr/check-image-pull.ts reads the estate
// Application from the cluster.
test("kustomize build deploy/ renders no Argo CD Application and every rendered namespaced object targets namespace corpus-ranker", () => {
  const objects = renderObjects();
  const apps = objects.filter((o) => o.apiVersion.startsWith("argoproj.io/") && (o.kind === "Application" || o.kind === "ApplicationSet" || o.kind === "AppProject"));
  assert.deepEqual(
    apps.map((o) => `${o.kind}/${o.metadata.namespace}/${o.metadata.name}`),
    [],
    "the estate Application is the one definition of argocd/corpus-ranker",
  );

  for (const o of objects) {
    if (o.kind === "Namespace") {
      assert.equal(o.metadata.name, NAMESPACE, `Namespace/${o.metadata.name} is not the ranker's namespace`);
      continue;
    }
    assert.equal(o.metadata.namespace, NAMESPACE, `${o.kind}/${o.metadata.name} is not in namespace ${NAMESPACE}`);
  }
});

test("the ranker API is a blue/green Rollout with active and preview Services, and no Deployment", () => {
  const objects = renderObjects();
  assert.equal(
    objects.filter((o) => o.kind === "Deployment" && o.metadata.name === "ranker-api").length,
    0,
    "ranker-api must be a Rollout, not a Deployment",
  );
  const rollout = findObject("Rollout", "ranker-api");
  assert.equal(rollout.apiVersion, "argoproj.io/v1alpha1");
  assert.equal(rollout.spec.strategy.canary, undefined);
  const bg = rollout.spec.strategy.blueGreen;
  assert.ok(bg, "the Rollout uses the blue/green strategy (TECH-STACK §10, DV-61)");
  assert.equal(bg.activeService, "ranker-api", "clients keep calling Service/ranker-api");
  assert.equal(bg.previewService, "ranker-api-preview");

  const podLabels = rollout.spec.template.metadata.labels;
  assert.deepEqual(rollout.spec.selector.matchLabels, { "app.kubernetes.io/name": "ranker-api" });
  for (const name of [bg.activeService, bg.previewService]) {
    const svc = findObject("Service", name);
    assert.equal(svc.spec.type ?? "ClusterIP", "ClusterIP", `Service/${name} stays estate-internal`);
    for (const [k, v] of Object.entries(svc.spec.selector as Record<string, string>)) {
      assert.equal(podLabels[k], v, `Service/${name} selects ${k}=${v}, which the Rollout's pods do not carry`);
    }
    assert.ok(wave(svc) <= wave(rollout), `Service/${name} must exist by the time the Rollout syncs`);
  }

  const containers = rollout.spec.template.spec.containers as Array<Record<string, any>>;
  const api = containers.find((c) => c.name === "api");
  assert.ok(api, "the Rollout runs the api container");
  assert.match(api.image, /^noncelogicci\.azurecr\.io\/corpus-ranker[:@]/);
});

test("the Rollout promotes a new revision only after its readiness probe, which checks the database and the object store, passes", () => {
  const rollout = findObject("Rollout", "ranker-api");
  const bg = rollout.spec.strategy.blueGreen;

  // Auto-promotion switches the active Service only once every preview pod is
  // Ready, i.e. its readiness probe passes; nothing promotes on a timer or
  // with only part of the preview ready.
  assert.notEqual(bg.autoPromotionEnabled, false, "promotion is gated by readiness, not by hand");
  assert.equal(bg.autoPromotionSeconds, undefined, "no timer promotes a revision");
  assert.equal(bg.previewReplicaCount, undefined, "the whole preview must be ready before promotion");

  const api = (rollout.spec.template.spec.containers as Array<Record<string, any>>).find((c) => c.name === "api")!;
  const readiness = api.readinessProbe;
  assert.ok(readiness?.httpGet, "the api container has an HTTP readiness probe");
  assert.equal(readiness.httpGet.path, "/readyz", "readiness is the dependency check (src/api/readiness.ts)");
  assert.equal(readiness.httpGet.port, "http");
  // The probe outlasts the service's own bound on each check, so a slow
  // dependency reports 503 "timeout" rather than a probe timeout.
  assert.ok(
    Number(readiness.timeoutSeconds) * 1000 > DEFAULT_READINESS_TIMEOUT_MS,
    `readinessProbe.timeoutSeconds ${readiness.timeoutSeconds} must exceed the ${DEFAULT_READINESS_TIMEOUT_MS}ms check bound`,
  );

  // Liveness stays independent of the dependencies: an outage makes the pod
  // unready (never promoted, out of the active Service) without restarting it.
  const liveness = api.livenessProbe;
  assert.ok(liveness?.httpGet, "the api container keeps an HTTP liveness probe");
  assert.equal(liveness.httpGet.path, "/healthz");
  assert.notEqual(liveness.httpGet.path, readiness.httpGet.path);
});
