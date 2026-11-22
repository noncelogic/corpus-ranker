// CR-D1-PULL / CR-IMAGE-ACR acceptance: every rendered ranker workload
// references the noncelogicci.azurecr.io/corpus-ranker image (the estate
// Azure registry, INTENTS I21) and an imagePullSecret that an ExternalSecret
// syncs from OpenBao, so the estate can fetch the private ranker image.
//
// A "ranker workload" is any pod-bearing object whose pod template runs the
// ranker image (in a container or an init container). The API Rollout
// and the migration Job must be among them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderObjects, repoRoot, type K8sObject } from "./render.ts";
import { policyPaths } from "./openbao-dev.ts";

const REGISTRY = "noncelogicci.azurecr.io";
const RANKER_IMAGE = `${REGISTRY}/corpus-ranker`;
const PULL_SECRET = "ranker-registry-pull";
const PULL_PATH = "corpus-ranker/acr-pull";
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
    case "Rollout":
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
const isRankerImage = (image: string): boolean => image === RANKER_IMAGE || /^noncelogicci\.azurecr\.io\/corpus-ranker[:@]/.test(image);
/** Any reference to a corpus-ranker image, from whichever registry. */
const isAnyRankerImage = (image: string): boolean => /(^|\/)corpus-ranker(?:[:@]|$)/.test(image);

test("every rendered ranker workload references the noncelogicci.azurecr.io/corpus-ranker image and an imagePullSecret that an ExternalSecret syncs from OpenBao", () => {
  const objects = renderObjects();

  const workloads = objects.filter((o) => {
    const spec = podSpec(o);
    return spec !== undefined && imagesOf(spec).some(isRankerImage);
  });
  const ids = workloads.map((o) => `${o.kind}/${o.metadata.name}`);
  for (const expected of ["Rollout/ranker-api", "Job/ranker-db-migrate"]) {
    assert.ok(ids.includes(expected), `${expected} must run the ranker image ${RANKER_IMAGE}; ranker workloads: ${JSON.stringify(ids)}`);
  }

  for (const w of workloads) {
    const id = `${w.kind}/${w.metadata.name}`;
    const spec = podSpec(w)!;

    // The ranker image is the one published by .github/workflows/publish.yml.
    for (const image of imagesOf(spec).filter((i) => i.startsWith("ghcr.io/noncelogic/") || i.startsWith(`${REGISTRY}/`) || isAnyRankerImage(i))) {
      assert.match(image, /^noncelogicci\.azurecr\.io\/corpus-ranker[:@]/, `${id} pulls ${image}, not a pinned ${RANKER_IMAGE}`);
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

/** Render an ESO dockerconfigjson template of the one form the ranker uses, for given values. */
function renderDockerConfig(template: string, values: Record<string, string>): unknown {
  const text = template
    .replace(/\{\{\s*printf\s+"%s:%s"\s+\.(\w+)\s+\.(\w+)\s*\|\s*b64enc\s*\}\}/g, (_, a: string, b: string) =>
      Buffer.from(`${values[a]}:${values[b]}`).toString("base64"),
    )
    .replace(/\{\{\s*\.(\w+)\s*\}\}/g, (_, k: string) => {
      assert.ok(k in values, `template reads .${k}, which the ExternalSecret does not provide`);
      return values[k]!;
    });
  assert.doesNotMatch(text, /\{\{/, "template has an expression this check does not understand");
  return JSON.parse(text);
}

// Per-product registry credential (Rule: policies/placement-defaults.yaml#credentials;
// INTENTS I21): the ranker pulls from the estate Azure registry with its own
// pull-only ACR token corpus-ranker-pull, custodied at kv/corpus-ranker/acr-pull
// and readable by the estate External Secrets role. The GHCR pull secret,
// its store script and its OpenBao policy are gone.
test("the API Rollout and the migration Job pull noncelogicci.azurecr.io/corpus-ranker with ranker-registry-pull from kv/corpus-ranker/acr-pull", () => {
  const objects = renderObjects();

  for (const [kind, name] of [["Rollout", "ranker-api"], ["Job", "ranker-db-migrate"]] as const) {
    const w = objects.find((o) => o.kind === kind && o.metadata.name === name);
    assert.ok(w, `${kind}/${name} is not rendered`);
    const spec = podSpec(w)!;
    const ranker = imagesOf(spec).filter(isAnyRankerImage);
    assert.ok(ranker.length > 0, `${kind}/${name} runs no corpus-ranker image`);
    for (const image of ranker) assert.match(image, /^noncelogicci\.azurecr\.io\/corpus-ranker[:@]/, `${kind}/${name} pulls ${image}`);
    assert.deepEqual(
      ((spec.imagePullSecrets ?? []) as Array<{ name?: string }>).map((s) => s.name),
      [PULL_SECRET],
      `${kind}/${name} must pull with ${PULL_SECRET} alone`,
    );
  }

  const matches = objects.filter((o) => o.kind === "ExternalSecret" && o.metadata.name === PULL_SECRET);
  assert.equal(matches.length, 1, `exactly one ExternalSecret ${PULL_SECRET} must be rendered`);
  const es = matches[0]!;
  assert.equal(es.spec?.target?.name ?? es.metadata.name, PULL_SECRET);
  assert.deepEqual(
    { kind: es.spec?.secretStoreRef?.kind, name: es.spec?.secretStoreRef?.name },
    { kind: "ClusterSecretStore", name: "openbao" },
    `${PULL_SECRET} must read from the OpenBao ClusterSecretStore`,
  );
  assert.equal(es.spec?.dataFrom, undefined, `${PULL_SECRET} must not extract or generate whole keys via dataFrom`);

  const refs = ((es.spec?.data ?? []) as Array<{ secretKey?: string; remoteRef?: { key?: string; property?: string } }>).map((d) => ({
    secretKey: d.secretKey,
    key: d.remoteRef?.key,
    property: d.remoteRef?.property,
  }));
  assert.deepEqual(
    refs.toSorted((a, b) => String(a.secretKey).localeCompare(String(b.secretKey))),
    [
      { secretKey: "password", key: PULL_PATH, property: "password" },
      { secretKey: "username", key: PULL_PATH, property: "username" },
    ],
    `${PULL_SECRET} must read exactly username and password from kv/${PULL_PATH}`,
  );

  // The rendered Secret is a dockerconfigjson for the Azure registry alone.
  assert.equal(es.spec?.target?.template?.type, "kubernetes.io/dockerconfigjson");
  const config = renderDockerConfig(es.spec.target.template.data[".dockerconfigjson"], { username: "corpus-ranker-pull", password: "s3cret" }) as {
    auths: Record<string, { username: string; password: string; auth: string }>;
  };
  assert.deepEqual(Object.keys(config), ["auths"]);
  assert.deepEqual(Object.keys(config.auths), [REGISTRY], `the pull secret authenticates to ${REGISTRY} only`);
  assert.deepEqual(config.auths[REGISTRY], {
    username: "corpus-ranker-pull",
    password: "s3cret",
    auth: Buffer.from("corpus-ranker-pull:s3cret").toString("base64"),
  });

  // No other ExternalSecret reads the ranker's pull credential.
  const otherReaders = objects
    .filter((o) => o.kind === "ExternalSecret" && o.metadata.name !== PULL_SECRET)
    .filter((o) => JSON.stringify(o.spec ?? {}).includes(PULL_PATH))
    .map((o) => o.metadata.name);
  assert.deepEqual(otherReaders, [], `only ${PULL_SECRET} may read kv/${PULL_PATH}`);

  // The GHCR bridge is gone: no GHCR pull secret, nothing reads kv/corpus-ranker/ghcr-pull,
  // and its store script and OpenBao policy are deleted.
  assert.deepEqual(objects.filter((o) => o.metadata.name === "ranker-ghcr-pull").map((o) => o.kind), []);
  assert.doesNotMatch(JSON.stringify(objects), /ghcr\.io\/noncelogic|corpus-ranker\/ghcr-pull/);
  for (const f of ["deploy/openbao/store-ghcr-pull.sh", "deploy/openbao/external-secrets-ghcr-pull.hcl"]) {
    assert.ok(!existsSync(resolve(repoRoot, f)), `${f} must be deleted`);
  }
});

// CR-M3-D2-ACRPULL acceptance (Rule: policies/placement-defaults.yaml#estate, one
// exact path, read-only; Rule: policies/placement-defaults.yaml#credentials,
// pull-only, per product): the estate External Secrets role's grant on the
// ranker's ACR pull credential is declared in its own reviewed attach manifest,
// devops/openbao/kubernetes-roles/eso-obs.acr-pull.attach.json, which adds the
// existing exact-path policy external-secrets-corpus-ranker-acr-pull and nothing
// else to role eso-obs on mount kubernetes. eso-obs.attach.json is unchanged, and
// no check carries an estate-held exemption for kv/corpus-ranker/acr-pull.
const ROLES_DIR = "devops/openbao/kubernetes-roles";
const ACR_ATTACH_FILE = `${ROLES_DIR}/eso-obs.acr-pull.attach.json`;
const ACR_POLICY = "external-secrets-corpus-ranker-acr-pull";

interface AttachManifest {
  auth_mount: string;
  role: string;
  mode: string;
  add_token_policies: Array<{ name: string; file: string }>;
}

const readJson = (file: string): AttachManifest => JSON.parse(readFileSync(resolve(repoRoot, file), "utf8")) as AttachManifest;

/** The one exact kv key (ExternalSecret form) a policy file grants read on; throws on anything wider. */
function exactReadKey(file: string): string {
  const paths = [...policyPaths(readFileSync(resolve(repoRoot, file), "utf8"))];
  assert.equal(paths.length, 1, `${file} must grant exactly one path`);
  const [path, caps] = paths[0]!;
  assert.deepEqual(caps, ["read"], `${file} must grant read only`);
  const m = /^kv\/data\/(corpus-ranker\/[a-z0-9-]+)$/.exec(path);
  assert.ok(m, `${file} must grant one exact kv/data/corpus-ranker/<purpose> path, not ${path}`);
  return m[1]!;
}

/** Assert the ACR pull attach manifest: mount kubernetes, role eso-obs, add-only, exactly the ACR pull policy. */
function assertAcrAttach(a: AttachManifest): void {
  assert.deepEqual(Object.keys(a).sort(), ["add_token_policies", "auth_mount", "mode", "role"], "the manifest declares nothing but mount, role, mode and policies to add");
  assert.equal(a.auth_mount, "kubernetes");
  assert.equal(a.role, "eso-obs");
  assert.equal(a.mode, "add", "the attachment only adds; it removes or replaces nothing");
  assert.ok(Array.isArray(a.add_token_policies), "add_token_policies must be a list");
  assert.deepEqual(a.add_token_policies, [{ name: ACR_POLICY, file: `devops/openbao/policies/${ACR_POLICY}.hcl` }], `exactly ${ACR_POLICY}`);
  assert.equal(exactReadKey(a.add_token_policies[0]!.file), PULL_PATH, `${ACR_POLICY} grants read on kv/${PULL_PATH} alone`);
}

test("eso-obs.acr-pull.attach.json attaches exactly external-secrets-corpus-ranker-acr-pull add-only on mount kubernetes role eso-obs", () => {
  assert.ok(existsSync(resolve(repoRoot, ACR_ATTACH_FILE)), `${ACR_ATTACH_FILE} must exist`);
  const a = readJson(ACR_ATTACH_FILE);
  assertAcrAttach(a);

  // The check refuses a drifted manifest.
  const drift = (f: (x: AttachManifest) => void): AttachManifest => {
    const x = structuredClone(a);
    f(x);
    return x;
  };
  assert.throws(() => assertAcrAttach(drift((x) => (x.auth_mount = "kubernetes-aks"))));
  assert.throws(() => assertAcrAttach(drift((x) => (x.role = "eso"))));
  assert.throws(() => assertAcrAttach(drift((x) => (x.mode = "replace"))));
  assert.throws(() => assertAcrAttach(drift((x) => x.add_token_policies.pop())));
  assert.throws(() => assertAcrAttach(drift((x) => x.add_token_policies.push({ name: "external-secrets-corpus-ranker", file: "devops/openbao/policies/external-secrets-corpus-ranker.hcl" }))));
  assert.throws(() => assertAcrAttach(drift((x) => (x.add_token_policies[0]!.file = "devops/openbao/policies/external-secrets-corpus-ranker-minio.hcl"))));
  assert.throws(() => assertAcrAttach(drift((x) => ((x as unknown as Record<string, unknown>).remove_token_policies = ["default"]))));

  // The original two-policy manifest is left as it was: it does not also carry the ACR pull grant.
  const main = readJson(`${ROLES_DIR}/eso-obs.attach.json`);
  assert.deepEqual(main.add_token_policies.map((p) => p.name), ["external-secrets-corpus-ranker-minio", "external-secrets-corpus-ranker"]);
});

test("the ranker-registry-pull reader is covered by a manifest and no estate-held exemption remains", () => {
  // Every eso-obs attach manifest in the repository, and the kv keys its policies grant.
  const manifests = readdirSync(resolve(repoRoot, ROLES_DIR))
    .filter((f) => /^eso-obs(\.[a-z0-9-]+)?\.attach\.json$/.test(f))
    .map((f) => `${ROLES_DIR}/${f}`)
    .sort();
  assert.deepEqual(manifests, [ACR_ATTACH_FILE, `${ROLES_DIR}/eso-obs.attach.json`]);
  const grantedBy = new Map<string, string>();
  for (const file of manifests) {
    const a = readJson(file);
    assert.deepEqual([a.auth_mount, a.role, a.mode], ["kubernetes", "eso-obs", "add"], `${file} must add to role eso-obs on mount kubernetes`);
    for (const p of a.add_token_policies) {
      const key = exactReadKey(p.file);
      assert.ok(!grantedBy.has(key), `kv/${key} is granted by two manifests`);
      grantedBy.set(key, file);
    }
  }

  // Every ExternalSecret on the openbao store, ranker-registry-pull among them, reads only manifest-granted keys.
  const readers = renderObjects().filter((o) => o.kind === "ExternalSecret" && o.spec?.secretStoreRef?.kind === "ClusterSecretStore" && o.spec?.secretStoreRef?.name === "openbao");
  assert.ok(readers.some((o) => o.metadata.name === PULL_SECRET), `${PULL_SECRET} must read ClusterSecretStore openbao`);
  for (const es of readers) {
    const keys = [
      ...((es.spec?.data ?? []) as Array<{ remoteRef?: { key?: string } }>).map((d) => d.remoteRef?.key),
      ...((es.spec?.dataFrom ?? []) as Array<{ extract?: { key?: string } }>).map((d) => d.extract?.key),
    ];
    for (const key of keys) {
      assert.ok(typeof key === "string" && grantedBy.has(key), `ExternalSecret/${es.metadata.name} reads kv/${key}, which no eso-obs attach manifest grants`);
    }
  }
  assert.equal(grantedBy.get(PULL_PATH), ACR_ATTACH_FILE, `${PULL_SECRET}'s kv/${PULL_PATH} is granted by ${ACR_ATTACH_FILE}`);

  // No check or doc keeps an estate-held exemption for the ACR pull path.
  const self = "image-pull.test.ts";
  const sources = [
    ...readdirSync(resolve(repoRoot, "tests/deploy")).filter((f) => f.endsWith(".ts") && f !== self).map((f) => `tests/deploy/${f}`),
    ...readdirSync(resolve(repoRoot, "deploy/openbao")).filter((f) => f.endsWith(".ts")).map((f) => `deploy/openbao/${f}`),
    "devops/openbao/README.md",
    "devops/openbao/policies/external-secrets-corpus-ranker-acr-pull.hcl",
  ];
  const exempting = sources.filter((f) => /estate[- ]held|ESTATE_(GRANTED|HELD)/i.test(readFileSync(resolve(repoRoot, f), "utf8")));
  assert.deepEqual(exempting, [], "no estate-held exemption for kv/corpus-ranker/acr-pull may remain");
});
