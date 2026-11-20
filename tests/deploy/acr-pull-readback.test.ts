// CR-IMAGE-ACR-D1 acceptance (deploy step CRANK-212): deploy/acr/check-image-pull.ts
// reads the corpus-ranker Argo CD Application and the pods of the API
// Deployment and the migration Job back through kubectl, and exits 0 only when
//
//   - the Application's only kustomize image entry pins
//     noncelogicci.azurecr.io/corpus-ranker to a sha-<commit> tag,
//   - the Application carries no ExternalSecret patch (the ranker-ghcr-pull
//     bridge is gone), and
//   - every API and migration pod ran that pinned image.
//
// Otherwise it names each mismatch. The tests run the checker against a fake
// `kubectl` on PATH serving fixture reads in the shapes of
// `kubectl get applications.argoproj.io ... -o json` and
// `kubectl get pods -l ... -o json`; nothing here reaches the estate.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deployDir } from "./render.ts";

const checker = resolve(deployDir, "acr", "check-image-pull.ts");
const ACR = "noncelogicci.azurecr.io/corpus-ranker";
const SHA = "14095ff61463816b1b4ea2ab3328ebf73f07fda4";
const PINNED = `${ACR}:sha-${SHA}`;
const GHCR = `ghcr.io/noncelogic/corpus-ranker:sha-${SHA}`;
const PG = "ghcr.io/cloudnative-pg/postgresql:17.7-standard-trixie@sha256:e079dae5253fa6ed26fc65fda06d515af764dbec392dd4b46b17ab11eebd8131";
const DIGEST = "sha256:d81e672d0000000000000000000000000000000000000000000000000000000f";

const APP_ARGS = "get applications.argoproj.io corpus-ranker -n argocd -o json";
const API_ARGS = "get pods -n corpus-ranker -l app.kubernetes.io/name=ranker-api -o json";
const MIGRATE_ARGS = "get pods -n corpus-ranker -l app.kubernetes.io/name=ranker-db-migrate -o json";

/** The bridge patch meta-harness carried while the ranker pulled from GHCR. */
const GHCR_PATCH = {
  target: { kind: "ExternalSecret", name: "ranker-registry-pull" },
  patch: "- op: replace\n  path: /spec/data/0/remoteRef/key\n  value: corpus-ranker/ghcr-pull\n- op: replace\n  path: /spec/target/name\n  value: ranker-ghcr-pull\n",
};
/** A Job patch that stays until CRANK-208 deploys; not an ExternalSecret patch. */
const BAO_ADDR_PATCH = {
  target: { kind: "Job", name: "ranker-api-keys-generate" },
  patch: "- op: add\n  path: /spec/template/spec/containers/0/env/-\n  value: {name: BAO_ADDR, value: http://openbao.openbao.svc:8200}\n",
};

function application(kustomize: { images?: unknown; patches?: unknown[] }) {
  return JSON.stringify({
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    metadata: { name: "corpus-ranker", namespace: "argocd" },
    spec: {
      project: "default",
      destination: { server: "https://kubernetes.default.svc", namespace: "corpus-ranker" },
      source: { repoURL: "https://github.com/noncelogic/corpus-ranker", targetRevision: "main", path: "deploy", kustomize },
    },
    status: { sync: { status: "Synced" }, health: { status: "Healthy" } },
  });
}

function pod(name: string, spec: { initContainers?: Array<[string, string]>; containers: Array<[string, string]> }) {
  const status = (cs: Array<[string, string]>) =>
    cs.map(([n, image]) => ({ name: n, image, imageID: `${image.split(/[:@]/)[0]}@${DIGEST}` }));
  return {
    apiVersion: "v1",
    kind: "Pod",
    metadata: { name, namespace: "corpus-ranker" },
    spec: {
      initContainers: (spec.initContainers ?? []).map(([n, image]) => ({ name: n, image })),
      containers: spec.containers.map(([n, image]) => ({ name: n, image })),
    },
    status: { initContainerStatuses: status(spec.initContainers ?? []), containerStatuses: status(spec.containers) },
  };
}

const podList = (...items: unknown[]) => JSON.stringify({ apiVersion: "v1", kind: "List", items, metadata: { resourceVersion: "" } });
const apiPod = (name: string, image: string) => pod(name, { containers: [["api", image]] });
const migratePod = (name: string, image: string) => pod(name, { initContainers: [["migrations", image]], containers: [["migrate", PG]] });

interface Reads {
  app?: string;
  api: string;
  migrate: string;
}

const goodReads = (): Reads => ({
  app: application({ images: [PINNED], patches: [BAO_ADDR_PATCH] }),
  api: podList(apiPod("ranker-api-7c9d5b8f6d-x2k4q", PINNED)),
  migrate: podList(migratePod("ranker-db-migrate-8qz7m", PINNED)),
});

/** A fake `kubectl` on PATH: serves the three reads, or kubectl's NotFound error for an absent Application. */
function fakeKubectl(t: TestContext, reads: Reads) {
  const dir = mkdtempSync(join(tmpdir(), "fake-kubectl-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (reads.app !== undefined) writeFileSync(join(dir, "app.json"), reads.app);
  writeFileSync(join(dir, "api.json"), reads.api);
  writeFileSync(join(dir, "migrate.json"), reads.migrate);
  writeFileSync(join(dir, "calls"), "");
  const kubectl = join(dir, "kubectl");
  writeFileSync(kubectl, `#!/bin/sh
echo "$*" >> "${dir}/calls"
case "$*" in
  "${APP_ARGS}")
    [ -f "${dir}/app.json" ] && { cat "${dir}/app.json"; exit 0; }
    echo 'Error from server (NotFound): applications.argoproj.io "corpus-ranker" not found' >&2; exit 1 ;;
  "${API_ARGS}") cat "${dir}/api.json"; exit 0 ;;
  "${MIGRATE_ARGS}") cat "${dir}/migrate.json"; exit 0 ;;
esac
echo "fake kubectl: unexpected call: $*" >&2; exit 64
`);
  chmodSync(kubectl, 0o755);
  return { dir, calls: () => readFileSync(join(dir, "calls"), "utf8") };
}

function runChecker(pathPrefix: string) {
  const r = spawnSync(process.execPath, [checker], {
    encoding: "utf8",
    cwd: tmpdir(),
    env: { PATH: `${pathPrefix}:${process.env.PATH}`, HOME: process.env.HOME ?? "/tmp" },
  });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, output: `${r.stdout}${r.stderr}` };
}

test("readback passes when the Application pins the ACR sha tag without an ExternalSecret patch and the API and migration pods ran that image", (t) => {
  const kubectl = fakeKubectl(t, goodReads());
  const r = runChecker(kubectl.dir);
  assert.equal(r.code, 0, r.output);
  assert.equal(r.stderr, "");
  assert.ok(r.stdout.includes(PINNED), r.stdout);
  assert.match(r.stdout, /ranker-api-7c9d5b8f6d-x2k4q/);
  assert.match(r.stdout, /ranker-db-migrate-8qz7m/);
  // It read the Application and the two workloads' pods, and nothing else.
  assert.deepEqual(kubectl.calls().trim().split("\n").sort(), [API_ARGS, APP_ARGS, MIGRATE_ARGS].sort());

  // The explicit override form naming the same image, a rolled API with two pods, and no patches at all.
  const same = runChecker(
    fakeKubectl(t, {
      app: application({ images: [`${ACR}=${PINNED}`] }),
      api: podList(apiPod("ranker-api-7c9d5b8f6d-x2k4q", PINNED), apiPod("ranker-api-7c9d5b8f6d-9fj2w", PINNED)),
      migrate: podList(migratePod("ranker-db-migrate-8qz7m", PINNED)),
    }).dir,
  );
  assert.equal(same.code, 0, same.output);
});

test("readback fails naming the bridge entry when the Application still carries the ghcr.io image override or the ranker-ghcr-pull ExternalSecret patch", (t) => {
  const cases: Array<{ name: string; app?: string; expect: RegExp[] }> = [
    {
      name: "the ghcr.io image override (today's bridge)",
      app: application({ images: [`${ACR}=${GHCR}`], patches: [GHCR_PATCH, BAO_ADDR_PATCH] }),
      expect: [/image entry .*ghcr\.io\/noncelogic\/corpus-ranker/, /ExternalSecret\/ranker-registry-pull/, /ranker-ghcr-pull/],
    },
    {
      name: "the ghcr.io image override alone",
      app: application({ images: [`${ACR}=${GHCR}`], patches: [BAO_ADDR_PATCH] }),
      expect: [/image entry .*ghcr\.io\/noncelogic\/corpus-ranker/],
    },
    {
      name: "the ExternalSecret patch alone",
      app: application({ images: [PINNED], patches: [GHCR_PATCH, BAO_ADDR_PATCH] }),
      expect: [/patch .*ExternalSecret\/ranker-registry-pull/, /ranker-ghcr-pull/],
    },
    {
      name: "an ExternalSecret patch whose target is only in the patch text",
      app: application({
        images: [PINNED],
        patches: [{ patch: "apiVersion: external-secrets.io/v1\nkind: ExternalSecret\nmetadata:\n  name: ranker-registry-pull\nspec:\n  target:\n    name: ranker-ghcr-pull\n" }],
      }),
      expect: [/patch .*ExternalSecret/, /ranker-ghcr-pull/],
    },
    {
      name: "a second image entry next to the ACR pin",
      app: application({ images: [PINNED, GHCR] }),
      expect: [/2 image entries/, /ghcr\.io\/noncelogic\/corpus-ranker/],
    },
    {
      name: "an ACR entry that is not a sha tag",
      app: application({ images: [`${ACR}:main`] }),
      expect: [/image entry .*corpus-ranker:main.* sha-/],
    },
    {
      name: "no image entry",
      app: application({}),
      expect: [/no image entry/],
    },
    {
      name: "an absent Application",
      expect: [/Application argocd\/corpus-ranker: absent/],
    },
  ];
  for (const c of cases) {
    const reads = goodReads();
    const kubectl = fakeKubectl(t, { ...reads, app: c.app });
    const r = runChecker(kubectl.dir);
    assert.equal(r.code, 1, `${c.name}: expected exit 1\n${r.output}`);
    for (const re of c.expect) assert.match(r.stderr, re, `${c.name}: stderr must name ${re}\n${r.stderr}`);
  }
});

test("readback fails naming the workload when an API or migration pod ran an image other than the pinned noncelogicci.azurecr.io sha tag", (t) => {
  const OTHER_SHA = `${ACR}:sha-${"a".repeat(40)}`;
  const cases: Array<{ name: string; api?: string; migrate?: string; expect: RegExp[]; not?: RegExp[] }> = [
    {
      name: "an API pod still on the ghcr.io image",
      api: podList(apiPod("ranker-api-7c9d5b8f6d-x2k4q", PINNED), apiPod("ranker-api-5f6b7d9c8-old11", GHCR)),
      expect: [/Deployment\/ranker-api: pod ranker-api-5f6b7d9c8-old11 container api ran ghcr\.io\/noncelogic\/corpus-ranker/],
      not: [/x2k4q/],
    },
    {
      name: "a migration pod on another sha",
      migrate: podList(migratePod("ranker-db-migrate-8qz7m", OTHER_SHA)),
      expect: [/Job\/ranker-db-migrate: pod ranker-db-migrate-8qz7m container migrations ran .*sha-a{40}/],
    },
    {
      name: "an API pod on the unpinned main tag",
      api: podList(apiPod("ranker-api-7c9d5b8f6d-x2k4q", `${ACR}:main`)),
      expect: [/Deployment\/ranker-api: pod ranker-api-7c9d5b8f6d-x2k4q container api ran .*corpus-ranker:main/],
    },
    {
      name: "a pod whose spec names the pin but whose status reports another image",
      api: podList({
        ...apiPod("ranker-api-7c9d5b8f6d-x2k4q", PINNED),
        status: { containerStatuses: [{ name: "api", image: GHCR, imageID: `ghcr.io/noncelogic/corpus-ranker@${DIGEST}` }] },
      }),
      expect: [/Deployment\/ranker-api: pod ranker-api-7c9d5b8f6d-x2k4q container api ran ghcr\.io/],
    },
    {
      name: "no migration pod left to read",
      migrate: podList(),
      expect: [/Job\/ranker-db-migrate: no pod found/],
    },
    {
      name: "no API pod",
      api: podList(),
      expect: [/Deployment\/ranker-api: no pod found/],
    },
    {
      name: "a migration pod without the ranker init container",
      migrate: podList(pod("ranker-db-migrate-8qz7m", { containers: [["migrate", PG]] })),
      expect: [/Job\/ranker-db-migrate: pod ranker-db-migrate-8qz7m runs no init container migrations/],
    },
  ];
  for (const c of cases) {
    const reads = goodReads();
    const kubectl = fakeKubectl(t, { ...reads, ...(c.api ? { api: c.api } : {}), ...(c.migrate ? { migrate: c.migrate } : {}) });
    const r = runChecker(kubectl.dir);
    assert.equal(r.code, 1, `${c.name}: expected exit 1\n${r.output}`);
    for (const re of c.expect) assert.match(r.stderr, re, `${c.name}: stderr must name ${re}\n${r.stderr}`);
    for (const re of c.not ?? []) assert.doesNotMatch(r.stderr, re, `${c.name}: stderr must not name ${re}\n${r.stderr}`);
  }
});
