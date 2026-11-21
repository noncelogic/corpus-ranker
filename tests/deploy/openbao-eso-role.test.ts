// CR-M3-D2-ESOATTACH acceptance: devops/openbao/kubernetes-roles/eso-obs.attach.json
// declares, for auth mount `kubernetes` and role `eso-obs` (the role the
// `openbao` ClusterSecretStore logs in with), an add-only attachment of
// exactly external-secrets-corpus-ranker-minio then external-secrets-corpus-ranker,
// each a policy file in devops/openbao/policies granting read on one exact kv
// path (Rule: policies/placement-defaults.yaml#estate secrets;
// Rule: policies/placement-defaults.yaml#code_location). Every ExternalSecret
// in the deploy overlay that reads ClusterSecretStore `openbao` reads only a
// path those policies grant or the role's estate-held ACR pull grant
// (kv/corpus-ranker/acr-pull, meta-harness devops/aks/corpus-ranker-argo/README.md)
// covers, and the generator-sourced database ExternalSecrets read no store
// (Rule: policies/placement-defaults.yaml#estate grants_from_spec).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderObjects, repoRoot, type K8sObject } from "./render.ts";
import { policyPaths } from "./openbao-dev.ts";

const ATTACH_FILE = "devops/openbao/kubernetes-roles/eso-obs.attach.json";
const ATTACHED = ["external-secrets-corpus-ranker-minio", "external-secrets-corpus-ranker"];
/**
 * The role's estate-held grant on the ranker's ACR pull credential (INTENTS I21):
 * kept in meta-harness devops/aks/corpus-ranker-argo/README.md, not in this repo.
 */
const ESTATE_GRANTED = ["corpus-ranker/acr-pull"];
const GENERATED = ["ranker-db-migrator", "ranker-db-service"];

interface Attach {
  auth_mount: string;
  role: string;
  mode: string;
  add_token_policies: Array<{ name: string; file: string }>;
}

const readAttach = (): Attach => JSON.parse(readFileSync(resolve(repoRoot, ATTACH_FILE), "utf8")) as Attach;

/** The one exact kv path (the ExternalSecret key form, without kv/data/) a read-only policy file grants. */
function grantedPath(file: string): string {
  const hcl = readFileSync(resolve(repoRoot, file), "utf8");
  const paths = [...policyPaths(hcl)];
  assert.equal(paths.length, 1, `${file} must grant exactly one path`);
  const [path, caps] = paths[0]!;
  assert.deepEqual(caps, ["read"], `${file} must grant read only`);
  assert.doesNotMatch(path, /[*+]/, `${file} must not grant a wildcard`);
  const m = /^kv\/data\/(corpus-ranker\/[a-z0-9-]+)$/.exec(path);
  assert.ok(m, `${file} must grant one exact kv/corpus-ranker/<purpose> data path, not ${path}`);
  return m[1]!;
}

/** Assert the attach manifest's shape: mount, role, add-only, the two ranker read policies in order. */
function assertAttach(a: Attach): void {
  assert.deepEqual(Object.keys(a).sort(), ["add_token_policies", "auth_mount", "mode", "role"], "the attach manifest declares nothing but mount, role, mode and policies to add");
  assert.equal(a.auth_mount, "kubernetes");
  assert.equal(a.role, "eso-obs");
  assert.equal(a.mode, "add", "the attachment only adds policies; it removes or replaces none");
  assert.deepEqual(
    a.add_token_policies.map((p) => p.name),
    ATTACHED,
    "exactly external-secrets-corpus-ranker-minio then external-secrets-corpus-ranker",
  );
  for (const p of a.add_token_policies) {
    assert.deepEqual(Object.keys(p).sort(), ["file", "name"]);
    assert.equal(p.file, `devops/openbao/policies/${p.name}.hcl`, `${p.name} must be a policy file in devops/openbao/policies`);
    assert.ok(existsSync(resolve(repoRoot, p.file)), `${p.file} does not exist`);
    grantedPath(p.file);
  }
}

/** Every store an ExternalSecret reads (spec-level and per-entry). */
function storesRead(es: K8sObject): Array<{ kind?: string; name?: string }> {
  const s = es.spec ?? {};
  const entries = [...(s.data ?? []), ...(s.dataFrom ?? [])] as Array<Record<string, any>>;
  return [s.secretStoreRef, ...entries.map((e) => e.sourceRef?.storeRef)].filter(Boolean);
}

/** Every remote key an ExternalSecret reads from a store. */
function remoteKeys(es: K8sObject): string[] {
  const s = es.spec ?? {};
  return [
    ...((s.data ?? []) as Array<Record<string, any>>).map((d) => d.remoteRef?.key),
    ...((s.dataFrom ?? []) as Array<Record<string, any>>).flatMap((d) => [d.extract?.key, d.find ? "<find>" : undefined]),
  ].filter((k): k is string => k !== undefined);
}

/** Assert every ExternalSecret reading ClusterSecretStore openbao reads only `granted`, and the generator-sourced ones read no store. */
function assertReadsGranted(objs: K8sObject[], granted: Set<string>): void {
  const ess = objs.filter((o) => o.kind === "ExternalSecret");
  const openbaoReaders = ess.filter((es) => storesRead(es).some((r) => r.kind === "ClusterSecretStore" && r.name === "openbao"));
  assert.ok(openbaoReaders.length > 0, "no ExternalSecret reads ClusterSecretStore openbao");
  for (const es of openbaoReaders) {
    const keys = remoteKeys(es);
    assert.ok(keys.length > 0, `ExternalSecret/${es.metadata.name} reads openbao but names no key`);
    for (const key of keys) {
      assert.ok(granted.has(key), `ExternalSecret/${es.metadata.name} reads kv/${key}, which no eso-obs policy grants`);
    }
  }
  for (const name of GENERATED) {
    const es = ess.find((o) => o.metadata.name === name);
    assert.ok(es, `rendered manifests have no ExternalSecret/${name}`);
    assert.deepEqual(storesRead(es), [], `ExternalSecret/${name} must read no store`);
    assert.deepEqual(remoteKeys(es), [], `ExternalSecret/${name} must read no remote key`);
    const refs = ((es.spec.dataFrom ?? []) as Array<Record<string, any>>).map((d) => d.sourceRef?.generatorRef?.name);
    assert.deepEqual(refs, ["ranker-db-password"], `ExternalSecret/${name} must be sourced from the ranker-db-password generator alone`);
  }
}

const grantedByRole = (a: Attach): Set<string> => new Set([...a.add_token_policies.map((p) => grantedPath(p.file)), ...ESTATE_GRANTED]);

test("the eso-obs attach manifest names mount kubernetes, role eso-obs and exactly the two ranker read policy files, adding only", () => {
  const a = readAttach();
  assertAttach(a);
  assert.deepEqual(
    a.add_token_policies.map((p) => grantedPath(p.file)),
    ["corpus-ranker/minio", "corpus-ranker/api-keys"],
  );

  // The checks refuse a drifted manifest.
  const drift = (f: (x: Attach) => void): Attach => {
    const x = structuredClone(a);
    f(x);
    return x;
  };
  assert.throws(() => assertAttach(drift((x) => (x.auth_mount = "kubernetes-aks"))));
  assert.throws(() => assertAttach(drift((x) => (x.role = "eso"))));
  assert.throws(() => assertAttach(drift((x) => (x.mode = "replace"))));
  assert.throws(() => assertAttach(drift((x) => x.add_token_policies.reverse())));
  assert.throws(() => assertAttach(drift((x) => x.add_token_policies.pop())));
  assert.throws(() => assertAttach(drift((x) => x.add_token_policies.push({ name: "corpus-ranker-api-keys", file: "devops/openbao/policies/corpus-ranker-api-keys.hcl" }))));
  assert.throws(() => assertAttach(drift((x) => (x.add_token_policies[0]!.file = "deploy/openbao/external-secrets-corpus-ranker-minio.hcl"))));
  assert.throws(() => assertAttach(drift((x) => ((x as unknown as Record<string, unknown>).remove_token_policies = ["default"]))));
  // A write-back policy (read and patch) is not a read grant.
  assert.throws(() => grantedPath("devops/openbao/policies/corpus-ranker-minio-provision.hcl"));
});

test("every ExternalSecret that reads ClusterSecretStore openbao reads only a kv path an attached policy or the role's estate-held ACR pull grant covers, and the generator-sourced database ExternalSecrets read no store", () => {
  const objs = renderObjects();
  const granted = grantedByRole(readAttach());
  assert.deepEqual([...granted].sort(), ["corpus-ranker/acr-pull", "corpus-ranker/api-keys", "corpus-ranker/minio"]);
  assertReadsGranted(objs, granted);

  // The check refuses an ungranted path, a find, and a store read on a generated secret.
  const mutate = (name: string, f: (spec: Record<string, any>) => void): K8sObject[] =>
    objs.map((o) => {
      if (o.kind !== "ExternalSecret" || o.metadata.name !== name) return o;
      const c = structuredClone(o);
      f(c.spec);
      return c;
    });
  assert.throws(() => assertReadsGranted(mutate("ranker-api-keys", (s) => (s.dataFrom = [{ extract: { key: "corpus-ranker/db" } }])), granted));
  assert.throws(() => assertReadsGranted(mutate("ranker-minio", (s) => (s.data[0].remoteRef.key = "other-product/minio")), granted));
  assert.throws(() => assertReadsGranted(mutate("ranker-api-keys", (s) => (s.dataFrom = [{ find: { path: "corpus-ranker" } }])), granted));
  assert.throws(() => assertReadsGranted(mutate("ranker-db-service", (s) => (s.secretStoreRef = { kind: "ClusterSecretStore", name: "openbao" })), granted));
  assert.throws(() =>
    assertReadsGranted(
      mutate("ranker-db-migrator", (s) => s.data = [{ secretKey: "x", sourceRef: { storeRef: { kind: "ClusterSecretStore", name: "openbao" } }, remoteRef: { key: "corpus-ranker/acr-pull" } }]),
      granted,
    ),
  );
});

// CR-M3-D2-ESOROLEb acceptance: the three ranker readers of the eso-obs
// attached policies are pinned by name to ClusterSecretStore `openbao` and to
// the exact kv/data/corpus-ranker/api-keys and kv/data/corpus-ranker/minio
// grants of external-secrets-corpus-ranker and external-secrets-corpus-ranker-minio
// (granted and read back 2026-11-20, CRANK-188; Rule: policies/placement-defaults.yaml#estate,
// Rule: policies/placement-defaults.yaml#code_location). The estate-held ACR pull
// grant is not one of those policies, so none of these readers may use it.
const ATTACHED_READERS: Record<string, string> = {
  "ranker-api-keys": "kv/data/corpus-ranker/api-keys",
  "ranker-minio": "kv/data/corpus-ranker/minio",
  "ranker-minio-service": "kv/data/corpus-ranker/minio",
};

/** The policy-path form (kv v2 data path) of an ExternalSecret remote key on the `openbao` store. */
const dataPath = (key: string): string => `kv/data/${key}`;

/** Assert each named reader exists, reads only ClusterSecretStore openbao, and reads only its attached-policy path. */
function assertAttachedReaders(objs: K8sObject[], a: Attach): void {
  const policyPath = new Map(a.add_token_policies.map((p) => [p.name, dataPath(grantedPath(p.file))]));
  assert.deepEqual(
    Object.fromEntries(policyPath),
    { "external-secrets-corpus-ranker-minio": "kv/data/corpus-ranker/minio", "external-secrets-corpus-ranker": "kv/data/corpus-ranker/api-keys" },
    "the eso-obs attached policies grant exactly kv/data/corpus-ranker/minio and kv/data/corpus-ranker/api-keys",
  );
  const attachedPaths = new Set(policyPath.values());
  for (const [name, expected] of Object.entries(ATTACHED_READERS)) {
    const matches = objs.filter((o) => o.kind === "ExternalSecret" && o.metadata.name === name);
    assert.equal(matches.length, 1, `exactly one ExternalSecret/${name} must be rendered`);
    const es = matches[0]!;
    const s = es.spec ?? {};
    assert.deepEqual(s.secretStoreRef, { kind: "ClusterSecretStore", name: "openbao" }, `ExternalSecret/${name} must read ClusterSecretStore openbao`);
    assert.deepEqual(storesRead(es), [s.secretStoreRef], `ExternalSecret/${name} must read no store but ClusterSecretStore openbao`);
    const entries = [...(s.data ?? []), ...(s.dataFrom ?? [])] as Array<Record<string, any>>;
    assert.ok(entries.length > 0, `ExternalSecret/${name} reads nothing`);
    for (const e of entries) {
      assert.equal(e.sourceRef, undefined, `ExternalSecret/${name} must not name an alternate source`);
      assert.equal(e.find, undefined, `ExternalSecret/${name} must not search the store`);
    }
    const keys = remoteKeys(es);
    assert.equal(keys.length, entries.length, `every entry of ExternalSecret/${name} must name one remote key`);
    for (const key of keys) {
      assert.ok(attachedPaths.has(dataPath(key)), `ExternalSecret/${name} reads ${dataPath(key)}, which no eso-obs attached policy grants`);
      assert.equal(dataPath(key), expected, `ExternalSecret/${name} must read only ${expected}`);
    }
  }
}

test("ranker-api-keys, ranker-minio and ranker-minio-service each read through ClusterSecretStore openbao only the kv/data/corpus-ranker path an eso-obs attached policy grants", () => {
  const objs = renderObjects();
  const a = readAttach();
  assertAttach(a);
  assertAttachedReaders(objs, a);

  // The check refuses a missing reader, another store, an alternate source, a
  // search, the registry exception, and a path the other policy grants.
  const mutate = (name: string, f: (spec: Record<string, any>) => void): K8sObject[] =>
    objs.map((o) => {
      if (o.kind !== "ExternalSecret" || o.metadata.name !== name) return o;
      const c = structuredClone(o);
      f(c.spec);
      return c;
    });
  assert.throws(() => assertAttachedReaders(objs.filter((o) => !(o.kind === "ExternalSecret" && o.metadata.name === "ranker-minio-service")), a));
  assert.throws(() => assertAttachedReaders(mutate("ranker-minio", (s) => (s.secretStoreRef = { kind: "SecretStore", name: "openbao" })), a));
  assert.throws(() => assertAttachedReaders(mutate("ranker-api-keys", (s) => (s.secretStoreRef = { kind: "ClusterSecretStore", name: "vault" })), a));
  assert.throws(() =>
    assertAttachedReaders(
      mutate("ranker-minio-service", (s) => (s.data[0].sourceRef = { storeRef: { kind: "ClusterSecretStore", name: "azure-kv" } })),
      a,
    ),
  );
  assert.throws(() => assertAttachedReaders(mutate("ranker-api-keys", (s) => (s.dataFrom = [{ sourceRef: { generatorRef: { kind: "Password", name: "ranker-db-password" } } }])), a));
  assert.throws(() => assertAttachedReaders(mutate("ranker-api-keys", (s) => (s.dataFrom = [{ find: { path: "corpus-ranker" } }])), a));
  assert.throws(() => assertAttachedReaders(mutate("ranker-minio", (s) => (s.data[0].remoteRef.key = "corpus-ranker/acr-pull")), a));
  assert.throws(() => assertAttachedReaders(mutate("ranker-api-keys", (s) => (s.dataFrom = [{ extract: { key: "corpus-ranker/minio" } }])), a));
  assert.throws(() => assertAttachedReaders(mutate("ranker-minio-service", (s) => (s.data[1].remoteRef.key = "corpus-ranker/api-keys")), a));
});
