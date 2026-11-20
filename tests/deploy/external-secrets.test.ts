// CR-D1-SECRETS / CR-D1-SECRETS-OVERLAY / CR-D1-SECRETS-WIRE acceptance: every secret the rendered ranker API Deployment
// reads at boot (secret-backed env vars, envFrom Secrets, secret volumes and
// its image pull Secret) is materialised by an ExternalSecret that reads the
// estate OpenBao through the ClusterSecretStore `openbao`, from paths under
// kv/corpus-ranker only. RANKER_DATABASE_URL is the one exact exception: its
// Secret is generated in-cluster by CR-D1-DBPASS's non-refreshing
// `ranker-db-password` Password generator (tests/deploy/db-passwords.test.ts)
// and reads no OpenBao path. A generator source for any other runtime secret
// is refused. Nothing secret is rendered from git.
//
// The API keys themselves are generated into kv/corpus-ranker/api-keys by
// the ranker-api-keys-generate Sync hook Job (deploy/api-keys/generate.sh),
// which never prints them (tests/deploy/api-keys-job.test.ts).
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deployDir, renderObjects, repoRoot, type K8sObject } from "./render.ts";
import { docker, policyPaths, startDevOpenBao } from "./openbao-dev.ts";

const NAMESPACE = "corpus-ranker";
const OPENBAO_PREFIX = "corpus-ranker/";
/** The one runtime secret not custodied in OpenBao, and the only generator allowed to source it. */
const GENERATED_ENV = "RANKER_DATABASE_URL";
const DB_GENERATOR = { apiVersion: "generators.external-secrets.io/v1alpha1", kind: "Password", name: "ranker-db-password" };
/** Env vars the service refuses to boot without (src/config.ts loadServiceConfig), plus its database URL. */
const BOOT_SECRET_ENV = ["RANKER_S3_ACCESS_KEY_ID", "RANKER_S3_SECRET_ACCESS_KEY", GENERATED_ENV];
const SECRETISH = /KEY|SECRET|PASSWORD|TOKEN|CREDENTIAL|DATABASE_URL/;

interface EnvVar {
  name: string;
  value?: unknown;
  valueFrom?: { secretKeyRef?: { name: string; key: string; optional?: boolean } };
}

/** ESO treats a zero refresh interval as "never refresh". */
const isZeroDuration = (v: unknown): boolean => v === 0 || (typeof v === "string" && /^0+(?:\.0+)?(?:ns|us|µs|ms|s|m|h)?$/.test(v));

function find(objs: K8sObject[], kind: string, name: string): K8sObject {
  const obj = objs.find((o) => o.kind === kind && o.metadata?.name === name);
  assert.ok(obj, `rendered manifests have no ${kind}/${name}`);
  return obj;
}

function containers(o: K8sObject): Array<Record<string, any>> {
  const spec = o.spec?.template?.spec ?? {};
  return [...(spec.initContainers ?? []), ...(spec.containers ?? [])];
}

/** The single ExternalSecret materialising Secret `secretName`. */
function externalSecretFor(objs: K8sObject[], secretName: string): K8sObject {
  const matches = objs.filter((o) => o.kind === "ExternalSecret" && (o.spec?.target?.name ?? o.metadata.name) === secretName);
  assert.equal(matches.length, 1, `Secret ${secretName} must be materialised by exactly one ExternalSecret (found ${matches.length})`);
  return matches[0]!;
}

/** Assert the ExternalSecret reads only OpenBao, through ClusterSecretStore `openbao`, under kv/corpus-ranker. */
function assertFromOpenBao(es: K8sObject): void {
  const name = `ExternalSecret/${es.metadata.name}`;
  assert.equal(es.metadata.namespace, NAMESPACE, `${name} must live in ${NAMESPACE}`);
  const data: Array<Record<string, any>> = es.spec.data ?? [];
  const dataFrom: Array<Record<string, any>> = es.spec.dataFrom ?? [];
  assert.ok(data.length + dataFrom.length > 0, `${name} has no source`);
  assert.deepEqual(es.spec.secretStoreRef, { kind: "ClusterSecretStore", name: "openbao" }, `${name} must read the estate OpenBao store`);
  const keys = [
    ...data.map((d) => {
      assert.equal(d.sourceRef, undefined, `${name} must not mix in other sources`);
      return d.remoteRef?.key;
    }),
    ...dataFrom.map((d) => {
      assert.equal(d.find, undefined, `${name} must name its OpenBao paths, not search for them`);
      assert.equal(d.sourceRef, undefined, `${name} must not mix in other sources (a generator is refused here)`);
      return d.extract?.key;
    }),
  ];
  for (const key of keys) {
    assert.ok(typeof key === "string" && key.startsWith(OPENBAO_PREFIX) && !key.includes(".."), `${name} reads OpenBao path ${key}, outside kv/corpus-ranker`);
  }
}

/** Assert the ExternalSecret is sourced only by the non-refreshing in-namespace ranker-db-password generator. */
function assertFromDbGenerator(objs: K8sObject[], es: K8sObject): void {
  const name = `ExternalSecret/${es.metadata.name}`;
  assert.equal(es.metadata.namespace, NAMESPACE, `${name} must live in ${NAMESPACE}`);
  assert.equal(es.spec.secretStoreRef, undefined, `${name} must not read a SecretStore`);
  assert.equal(es.spec.data, undefined, `${name} must not read remote keys`);
  assert.ok(isZeroDuration(es.spec.refreshInterval), `${name} must not refresh (refreshInterval ${JSON.stringify(es.spec.refreshInterval)})`);
  const sources: Array<Record<string, any>> = es.spec.dataFrom ?? [];
  assert.equal(sources.length, 1, `${name} must have exactly one source`);
  assert.equal(sources[0]!.sourceRef?.storeRef, undefined, `${name} must not read another store`);
  assert.deepEqual(sources[0]!.sourceRef?.generatorRef, DB_GENERATOR, `${name} must be sourced by Password/ranker-db-password`);
  const gen = find(objs, DB_GENERATOR.kind, DB_GENERATOR.name);
  assert.equal(gen.metadata.namespace, NAMESPACE, `the generator must live in ${NAMESPACE}`);
}

/** Assert the ExternalSecret produces key `key` in its target Secret (when that is knowable). */
function assertProducesKey(es: K8sObject, key: string): void {
  const templateKeys = Object.keys(es.spec.target?.template?.data ?? {});
  const dataKeys = (es.spec.data ?? []).map((d: { secretKey: string }) => d.secretKey);
  const extracts = (es.spec.dataFrom ?? []).some((d: Record<string, unknown>) => d.extract);
  if (templateKeys.length > 0) assert.ok(templateKeys.includes(key), `ExternalSecret/${es.metadata.name} templates no key ${key}`);
  else if (!extracts) assert.ok(dataKeys.includes(key), `ExternalSecret/${es.metadata.name} produces no key ${key}`);
}

/** One Secret the rendered ranker API Deployment reads, and what reads it. */
interface SecretRead {
  /** `env NAME`, `envFrom <container>`, `volume <name>` or `imagePullSecret`. */
  consumer: string;
  secret: string;
  /** The Secret key an env var reads, when it reads one. */
  key?: string;
}

const DB_URL_READ = `env ${GENERATED_ENV}`;

/** Every Secret the rendered ranker-api Deployment reads at boot, after checking nothing secret bypasses a Secret. */
function bootSecretReads(objs: K8sObject[]): SecretRead[] {
  const deployment = find(objs, "Deployment", "ranker-api");
  const podSpec = deployment.spec.template.spec;
  const reads: SecretRead[] = [];
  let mountsApiKeys = false;

  for (const c of containers(deployment)) {
    for (const ref of c.envFrom ?? []) {
      assert.equal(ref.configMapRef, undefined, `container ${c.name} loads env from a ConfigMap; secrets must not hide there`);
      assert.notEqual(ref.secretRef?.optional, true, `container ${c.name} must not boot without Secret ${ref.secretRef?.name}`);
      reads.push({ consumer: `envFrom ${c.name}`, secret: ref.secretRef?.name });
    }
    for (const env of (c.env ?? []) as EnvVar[]) {
      const ref = env.valueFrom?.secretKeyRef;
      if (!ref) {
        assert.ok(!SECRETISH.test(env.name) || env.name === "RANKER_API_KEYS_DIR", `${env.name} looks secret but is not read from a Secret`);
        assert.equal(env.valueFrom, undefined, `${env.name} reads from something other than a Secret (${JSON.stringify(env.valueFrom)})`);
        continue;
      }
      assert.notEqual(ref.optional, true, `${env.name} must not be optional: the service needs it at boot`);
      reads.push({ consumer: `env ${env.name}`, secret: ref.name, key: ref.key });
    }

    // The API key set is a mounted Secret volume; RANKER_API_KEYS_DIR points the service at it.
    const keysDir = (c.env as EnvVar[] | undefined)?.find((e) => e.name === "RANKER_API_KEYS_DIR")?.value;
    if (keysDir !== undefined) {
      const mount = (c.volumeMounts ?? []).find((m: { mountPath: string }) => m.mountPath === keysDir);
      assert.ok(mount, `RANKER_API_KEYS_DIR=${keysDir} is not a volume mount of container ${c.name}`);
      const volume = (podSpec.volumes ?? []).find((v: { name: string }) => v.name === mount.name);
      assert.equal(volume?.secret?.secretName, "ranker-api-keys", "the API key directory must be the ranker-api-keys Secret");
      mountsApiKeys = true;
    }
  }
  assert.ok(mountsApiKeys, "the Deployment must set RANKER_API_KEYS_DIR to its mounted API key Secret");

  for (const volume of podSpec.volumes ?? []) {
    const names: string[] = [
      ...(volume.secret ? [volume.secret.secretName] : []),
      ...(volume.projected?.sources ?? []).filter((s: Record<string, any>) => s.secret).map((s: Record<string, any>) => s.secret.name),
    ];
    if (names.length > 0) assert.notEqual(volume.secret?.optional, true, `volume ${volume.name} must not be optional`);
    for (const secret of names) reads.push({ consumer: `volume ${volume.name}`, secret });
  }
  for (const pull of podSpec.imagePullSecrets ?? []) reads.push({ consumer: "imagePullSecret", secret: pull.name });

  for (const name of BOOT_SECRET_ENV) assert.ok(reads.some((r) => r.consumer === `env ${name}`), `the Deployment must read ${name} from a Secret`);
  // Nothing secret is rendered from git.
  for (const o of objs) assert.notEqual(o.kind, "Secret", `Secret/${o.metadata.name} is rendered from git`);
  return reads;
}

/** Does the ExternalSecret draw on a generator anywhere? */
const isGeneratorSourced = (es: K8sObject): boolean =>
  [...(es.spec.data ?? []), ...(es.spec.dataFrom ?? [])].some((d: Record<string, any>) => d.sourceRef?.generatorRef !== undefined);

/** Acceptance 1: every runtime secret but RANKER_DATABASE_URL comes from OpenBao under kv/corpus-ranker. */
function assertNonDatabaseSecretsFromOpenBao(objs: K8sObject[]): void {
  const reads = bootSecretReads(objs);
  const dbSecret = reads.find((r) => r.consumer === DB_URL_READ)!.secret;
  for (const read of reads) {
    if (read.consumer === DB_URL_READ) continue;
    assert.notEqual(read.secret, dbSecret, `${read.consumer} must not read the generated database Secret ${dbSecret}`);
    const es = externalSecretFor(objs, read.secret);
    assertFromOpenBao(es);
    if (read.key !== undefined) assertProducesKey(es, read.key);
  }
  // The API keys come straight from kv/corpus-ranker/api-keys, one property per principal.
  assert.deepEqual(externalSecretFor(objs, "ranker-api-keys").spec.dataFrom, [{ extract: { key: "corpus-ranker/api-keys" } }]);
}

/** Acceptance 2: RANKER_DATABASE_URL is the one generator-sourced read, from the non-refreshing ranker-db-password generator. */
function assertOnlyDatabaseUrlGenerated(objs: K8sObject[]): void {
  const reads = bootSecretReads(objs);
  const generated = reads.filter((r) => isGeneratorSourced(externalSecretFor(objs, r.secret))).map((r) => r.consumer);
  assert.deepEqual(generated, [DB_URL_READ], `only ${GENERATED_ENV} may be generator-sourced (generator-sourced: ${generated.join(", ")})`);
  const db = reads.find((r) => r.consumer === DB_URL_READ)!;
  const es = externalSecretFor(objs, db.secret);
  assertFromDbGenerator(objs, es);
  assertProducesKey(es, db.key!);
}

/** A copy of the render with `edit` applied to the `kind`/`name` object's spec. */
function withEdit(kind: string, name: string, edit: (spec: Record<string, any>) => void): K8sObject[] {
  const objs = structuredClone(renderObjects());
  edit(find(objs, kind, name).spec);
  return objs;
}
const withExternalSecret = (name: string, edit: (spec: Record<string, any>) => void): K8sObject[] => withEdit("ExternalSecret", name, edit);

const generatorSource = (spec: Record<string, any>): void => {
  delete spec.secretStoreRef;
  delete spec.data;
  spec.dataFrom = [{ sourceRef: { generatorRef: { ...DB_GENERATOR } } }];
};
const NON_DB_EXTERNAL_SECRETS = ["ranker-minio-service", "ranker-api-keys", "ranker-registry-pull"];

test("every non-database secret environment variable the rendered ranker Deployment reads is sourced from an ExternalSecret under kv/corpus-ranker, and RANKER_DATABASE_URL only from the non-refreshing Password generator", () => {
  const rendered = renderObjects();
  // Allowed: every other secret from kv/corpus-ranker, and RANKER_DATABASE_URL from the Password generator.
  assertNonDatabaseSecretsFromOpenBao(rendered);
  assertOnlyDatabaseUrlGenerated(rendered);

  // The rule bites: a generator source for any other runtime secret is refused ...
  for (const name of NON_DB_EXTERNAL_SECRETS) {
    assert.throws(() => assertNonDatabaseSecretsFromOpenBao(withExternalSecret(name, generatorSource)), /must read the estate OpenBao store/, `a generator-sourced ${name} was accepted`);
  }
  // ... even mixed in beside an OpenBao read,
  assert.throws(
    () => assertNonDatabaseSecretsFromOpenBao(withExternalSecret("ranker-minio-service", (s) => (s.dataFrom = [{ sourceRef: { generatorRef: { ...DB_GENERATOR } } }]))),
    /must not mix in other sources/,
  );
  // ... as is OpenBao outside kv/corpus-ranker, another store,
  assert.throws(() => assertNonDatabaseSecretsFromOpenBao(withExternalSecret("ranker-minio-service", (s) => (s.data[0].remoteRef.key = "other-app/minio"))), /outside kv\/corpus-ranker/);
  assert.throws(() => assertNonDatabaseSecretsFromOpenBao(withExternalSecret("ranker-api-keys", (s) => (s.secretStoreRef = { kind: "SecretStore", name: "openbao" }))));
  // ... a non-database variable riding on the generated database Secret,
  assert.throws(
    () =>
      assertNonDatabaseSecretsFromOpenBao(
        withEdit("Deployment", "ranker-api", (s) => {
          const env = s.template.spec.containers[0].env.find((e: EnvVar) => e.name === "RANKER_S3_SECRET_ACCESS_KEY");
          env.valueFrom.secretKeyRef = { name: "ranker-db-service", key: "password" };
        }),
      ),
    /must not read the generated database Secret/,
  );
  // ... and a secret-looking variable set in plain text.
  assert.throws(
    () =>
      assertNonDatabaseSecretsFromOpenBao(
        withEdit("Deployment", "ranker-api", (s) => s.template.spec.containers[0].env.push({ name: "RANKER_EXTRA_TOKEN", value: "x" })),
      ),
    /looks secret/,
  );

  // A generator source for any other runtime secret is refused: the exception is RANKER_DATABASE_URL alone.
  for (const name of NON_DB_EXTERNAL_SECRETS) {
    assert.throws(() => assertOnlyDatabaseUrlGenerated(withExternalSecret(name, generatorSource)), /only RANKER_DATABASE_URL may be generator-sourced/, `a generator-sourced ${name} was accepted`);
  }
  // The database URL comes only from the non-refreshing ranker-db-password Password generator.
  assert.throws(() => assertOnlyDatabaseUrlGenerated(withExternalSecret("ranker-db-service", (s) => (s.refreshInterval = "1h"))), /must not refresh/);
  assert.throws(() => assertOnlyDatabaseUrlGenerated(withExternalSecret("ranker-db-service", (s) => delete s.refreshInterval)), /must not refresh/);
  assert.throws(() => assertOnlyDatabaseUrlGenerated(withExternalSecret("ranker-db-service", (s) => (s.dataFrom[0].sourceRef.generatorRef.name = "other-password"))));
  assert.throws(() => assertOnlyDatabaseUrlGenerated(withExternalSecret("ranker-db-service", (s) => (s.dataFrom[0].sourceRef.generatorRef.kind = "UUID"))));
  assert.throws(() =>
    assertOnlyDatabaseUrlGenerated(
      withExternalSecret("ranker-db-service", (s) => {
        s.secretStoreRef = { kind: "ClusterSecretStore", name: "openbao" };
        s.dataFrom = [{ extract: { key: "corpus-ranker/db" } }];
      }),
    ),
  );
});

// CR-IMAGE-ACR (INTENTS I21; Rule: policies/placement-defaults.yaml#credentials):
// the ranker's own pull-only ACR token corpus-ranker-pull is custodied
// estate-side at kv/corpus-ranker/acr-pull, which the estate External Secrets
// role may read (meta-harness devops/aks/corpus-ranker-argo/README.md). The
// API's image pull secret is synced from that one path and nothing else.
test("the ranker's image pull secret is an ExternalSecret sourced from kv/corpus-ranker/acr-pull", () => {
  const objs = renderObjects();
  const api = find(objs, "Deployment", "ranker-api");
  const pullSecrets = ((api.spec.template.spec.imagePullSecrets ?? []) as Array<{ name: string }>).map((s) => s.name);
  assert.deepEqual(pullSecrets, ["ranker-registry-pull"], "the API pulls with the ranker's own pull secret only");
  const es = externalSecretFor(objs, "ranker-registry-pull");
  assertFromOpenBao(es);
  assert.equal(es.spec.target.template?.type, "kubernetes.io/dockerconfigjson");
  const keys = new Set((es.spec.data as Array<{ remoteRef: { key: string } }>).map((d) => d.remoteRef.key));
  assert.deepEqual([...keys], ["corpus-ranker/acr-pull"], "the pull secret reads kv/corpus-ranker/acr-pull and nothing else");
});

// CR-D1-SECRETS-ROLLOUT / CR-M3-D2d acceptance (CRANK-140; Rule: policies/placement-defaults.yaml#estate
// secrets): the API key ExternalSecret reads only kv/corpus-ranker/api-keys and
// the object-store ExternalSecrets read only kv/corpus-ranker/minio. The estate
// External Secrets role holds one policy per custody path:
// devops/openbao/policies/external-secrets-corpus-ranker.hcl grants read on
// kv/corpus-ranker/api-keys alone and
// devops/openbao/policies/external-secrets-corpus-ranker-minio.hcl read on
// kv/corpus-ranker/minio alone, each one exact path, no wildcard. Each file,
// loaded alone into a throwaway OpenBao, reads its path and nothing else.
const CUSTODY_PATHS = ["corpus-ranker/api-keys", "corpus-ranker/minio"] as const;
type CustodyPath = (typeof CUSTODY_PATHS)[number];

/** Every OpenBao path an ExternalSecret reads. */
const remotePaths = (es: K8sObject): string[] => [
  ...(es.spec.data ?? []).map((d: { remoteRef?: { key?: string } }) => d.remoteRef?.key),
  ...(es.spec.dataFrom ?? []).map((d: { extract?: { key?: string } }) => d.extract?.key),
];

/** Assert the ExternalSecrets read exactly `path` from OpenBao, by name. */
function assertExternalSecretsRead(objs: K8sObject[], names: string[], path: CustodyPath): void {
  for (const name of names) {
    const es = externalSecretFor(objs, name);
    assertFromOpenBao(es);
    assert.deepEqual(new Set(remotePaths(es)), new Set([path]), `ExternalSecret/${name} must read kv/${path} and nothing else`);
  }
}

/**
 * Assert `devops/openbao/policies/<policyName>.hcl` grants read on kv/<path> alone, and
 * that a token holding that policy alone (plus OpenBao's `default`) reads it
 * while the other custody path, writes, patch, delete, list and metadata are refused.
 */
async function assertSinglePathPolicy(t: TestContext, policyName: string, path: CustodyPath): Promise<void> {
  const other = CUSTODY_PATHS.find((p) => p !== path)!;
  const policyFile = resolve(repoRoot, "devops", "openbao", "policies", `${policyName}.hcl`);
  const policy = readFileSync(policyFile, "utf8");
  assert.deepEqual([...policyPaths(policy)], [[`kv/data/${path}`, ["read"]]], `${policyName} grants read on kv/${path} alone`);
  assert.doesNotMatch(policy.replace(/#.*$/gm, ""), /[*+]/, "no wildcard grants");

  const bao = await startDevOpenBao(t);
  docker(["cp", policyFile, `${bao.name}:/tmp/policy.hcl`]);
  bao.root("policy", "write", policyName, "/tmp/policy.hcl");
  bao.root("kv", "put", "-mount=kv", "corpus-ranker/api-keys", "joe=api-secret");
  bao.root("kv", "put", "-mount=kv", "corpus-ranker/minio", "root-user=r", "root-password=p", "service-user=s", "service-password=q");
  bao.root("kv", "put", "-mount=kv", "corpus-ranker/acr-pull", "username=u", "password=p");
  bao.root("kv", "put", "-mount=kv", "other-product/api-keys", "x=y");
  const before = bao.root("kv", "get", "-format=json", "-mount=kv", path);
  const token = JSON.parse(bao.root("token", "create", "-format=json", `-policy=${policyName}`)).auth.client_token as string;

  const [code, out] = bao.as(token, "kv", "get", "-format=json", "-mount=kv", path);
  assert.equal(code, 0, `${policyName} must read kv/${path}: ${out}`);

  const refused: string[][] = [
    ["kv", "get", "-mount=kv", other],
    ["kv", "put", "-mount=kv", path, "x=y"],
    ["kv", "patch", "-mount=kv", path, "x=y"],
    ["kv", "delete", "-mount=kv", path],
    ["kv", "put", "-mount=kv", other, "x=y"],
    ["kv", "list", "-mount=kv", "corpus-ranker"],
    ["kv", "metadata", "get", "-mount=kv", path],
    ["kv", "metadata", "get", "-mount=kv", other],
    ["kv", "get", "-mount=kv", "corpus-ranker/acr-pull"],
    ["kv", "get", "-mount=kv", `${path}-old`],
    ["kv", "get", "-mount=kv", "other-product/api-keys"],
    ["policy", "list"],
  ];
  for (const args of refused) {
    const [c, o] = bao.as(token, ...args);
    assert.notEqual(c, 0, `${policyName} must not: bao ${args.join(" ")}\n${o}`);
    assert.match(o, /permission denied|403/i, `bao ${args.join(" ")} failed for another reason: ${o}`);
  }
  const strip = (s: string) => JSON.stringify(JSON.parse(s).data);
  assert.equal(strip(bao.root("kv", "get", "-format=json", "-mount=kv", path)), strip(before), "the refused writes changed nothing");
}

test("the api-keys policy grants only read on the api-keys custody path and refuses the MinIO path", { timeout: 300_000 }, async (t) => {
  assertExternalSecretsRead(renderObjects(), ["ranker-api-keys"], "corpus-ranker/api-keys");
  await assertSinglePathPolicy(t, "external-secrets-corpus-ranker", "corpus-ranker/api-keys");
});

test("the MinIO policy grants only read on the MinIO custody path and refuses the api-keys path", { timeout: 300_000 }, async (t) => {
  assertExternalSecretsRead(renderObjects(), ["ranker-minio", "ranker-minio-service"], "corpus-ranker/minio");
  await assertSinglePathPolicy(t, "external-secrets-corpus-ranker-minio", "corpus-ranker/minio");
});

// CR-M3-D2c acceptance (Rule: policies/placement-defaults.yaml#estate grants_from_spec;
// Rule: policies/placement-defaults.yaml#estate secrets): the estate External
// Secrets role the `openbao` ClusterSecretStore logs in with (eso-obs on mount
// kubernetes, devops/openbao/kubernetes-roles/eso-obs.attach.json) ends up
// carrying external-secrets-corpus-ranker-minio and external-secrets-corpus-ranker,
// byte-identical to devops/openbao/policies, appended after the role's existing
// policies (eso-sync before the apply) with every other role setting
// unchanged. deploy/openbao/attach-eso.ts is the apply (CRANK-188): it
// snapshots the live role, writes each policy, appends only the missing names,
// then reads policy bytes and the role back. Run here against a throwaway
// OpenBao holding the role as the estate does before the apply; nothing here
// reaches the estate.
const ESO_ROLE = "auth/kubernetes/role/eso-obs";
const ESO_ATTACHED = ["external-secrets-corpus-ranker-minio", "external-secrets-corpus-ranker"] as const;
const ESO_PRIOR = "eso-sync";

test("the ExternalSecret store role names both exact-path corpus-ranker read policies", { timeout: 300_000 }, async (t) => {
  const bao = await startDevOpenBao(t);
  bao.root("auth", "enable", "kubernetes");
  docker(["exec", bao.name, "sh", "-c", `printf 'path "kv/data/estate/sync" {\\n  capabilities = ["read"]\\n}\\n' > /tmp/prior.hcl`]);
  bao.root("policy", "write", ESO_PRIOR, "/tmp/prior.hcl");
  bao.root("kv", "put", "-mount=kv", "estate/sync", "x=y");
  bao.root("kv", "put", "-mount=kv", "corpus-ranker/api-keys", "joe=api-secret");
  bao.root("kv", "put", "-mount=kv", "corpus-ranker/minio", "root-user=r", "root-password=p", "service-user=s", "service-password=q");
  // The role as the estate holds it before the apply: eso-sync only, with settings of its own that must survive.
  bao.root(
    "write", ESO_ROLE,
    "bound_service_account_names=external-secrets", "bound_service_account_namespaces=external-secrets",
    `token_policies=${ESO_PRIOR}`, "token_ttl=20m", "token_max_ttl=1h", "audience=openbao", "alias_name_source=serviceaccount_name",
  );
  const roleData = (): Record<string, unknown> => JSON.parse(bao.root("read", "-format=json", ESO_ROLE)).data;
  const snapshot = roleData();

  // `bao` on PATH runs the server's own CLI as root, as an operator logged in to OpenBao would.
  const dir = mkdtempSync(join(tmpdir(), "dev-bao-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "bao"), `#!/bin/sh\nexec docker exec -i -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN=root ${bao.name} bao "$@"\n`);
  chmodSync(join(dir, "bao"), 0o755);
  const run = (script: string) => {
    const r = spawnSync(process.execPath, [resolve(deployDir, "openbao", script)], {
      encoding: "utf8",
      cwd: tmpdir(),
      env: { PATH: `${dir}:${process.env.PATH}`, HOME: process.env.HOME ?? "/tmp" },
    });
    if (r.error) throw r.error;
    return { code: r.status, stdout: r.stdout, output: `${r.stdout}${r.stderr}` };
  };

  const applied = run("attach-eso.ts");
  assert.equal(applied.code, 0, applied.output);

  // The role names eso-sync, then both exact-path ranker read policies; nothing else about it changed.
  const after = roleData();
  assert.deepEqual(after.token_policies, [ESO_PRIOR, ...ESO_ATTACHED]);
  assert.deepEqual({ ...after, token_policies: undefined }, { ...snapshot, token_policies: undefined }, "every other role setting is preserved");
  // Each attached policy is byte-identical to its repository file, and grants one exact path, read-only.
  for (const name of ESO_ATTACHED) {
    const file = readFileSync(resolve(repoRoot, "devops", "openbao", "policies", `${name}.hcl`), "utf8");
    assert.equal(JSON.parse(bao.root("read", "-format=json", `sys/policy/${name}`)).data.rules, file, `${name} is byte-identical to main`);
    const paths = [...policyPaths(file)];
    assert.equal(paths.length, 1);
    assert.deepEqual(paths[0]![1], ["read"]);
    assert.doesNotMatch(paths[0]![0], /[*+]/);
  }
  // The record it prints for devops/openbao/README.md in meta-harness names the before and after lists.
  const record = JSON.parse(applied.stdout.trim().split("\n").at(-1)!);
  assert.deepEqual(record.token_policies_before, [ESO_PRIOR]);
  assert.deepEqual(record.appended, [...ESO_ATTACHED]);
  assert.deepEqual(record.token_policies_after, [ESO_PRIOR, ...ESO_ATTACHED]);
  assert.equal(record.settings_preserved, true);

  // A token holding the role's policies reads every path the rendered openbao ExternalSecrets read, and eso-sync's.
  const token = JSON.parse(bao.root("token", "create", "-format=json", ...(after.token_policies as string[]).map((p) => `-policy=${p}`))).auth.client_token as string;
  const keys = new Set(renderObjects().filter((o) => o.kind === "ExternalSecret" && o.spec?.secretStoreRef?.name === "openbao").flatMap(remotePaths));
  for (const key of [...keys].filter((k) => k !== "corpus-ranker/acr-pull")) {
    const [code, out] = bao.as(token, "kv", "get", "-mount=kv", key);
    assert.equal(code, 0, `the role cannot read kv/${key}: ${out}`);
  }
  assert.equal(bao.as(token, "kv", "get", "-mount=kv", "estate/sync")[0], 0, "eso-sync still grants its path");

  // The readback check agrees, and a second apply changes nothing (no duplicate names).
  const checked = run("check-eso-attach.ts");
  assert.equal(checked.code, 0, checked.output);
  const again = run("attach-eso.ts");
  assert.equal(again.code, 0, again.output);
  assert.deepEqual(JSON.parse(again.stdout.trim().split("\n").at(-1)!).appended, []);
  assert.deepEqual(roleData(), after);

  // A drifted (widened) ranker policy is rewritten to the repository bytes; eso-sync is never written.
  docker(["exec", bao.name, "sh", "-c", `printf 'path "kv/data/corpus-ranker/*" {\\n  capabilities = ["read", "list"]\\n}\\n' > /tmp/wide.hcl`]);
  bao.root("policy", "write", ESO_ATTACHED[0], "/tmp/wide.hcl");
  const prior = bao.root("read", "-format=json", `sys/policy/${ESO_PRIOR}`);
  const healed = run("attach-eso.ts");
  assert.equal(healed.code, 0, healed.output);
  assert.equal(
    JSON.parse(bao.root("read", "-format=json", `sys/policy/${ESO_ATTACHED[0]}`)).data.rules,
    readFileSync(resolve(repoRoot, "devops", "openbao", "policies", `${ESO_ATTACHED[0]}.hcl`), "utf8"),
  );
  assert.equal(JSON.parse(bao.root("read", "-format=json", `sys/policy/${ESO_PRIOR}`)).data.rules, JSON.parse(prior).data.rules);

  // An absent role is never created: exit 2, and no role appears.
  bao.root("delete", ESO_ROLE);
  const absent = run("attach-eso.ts");
  assert.equal(absent.code, 2, absent.output);
  assert.match(absent.output, /role auth\/kubernetes\/role\/eso-obs: absent/);
  assert.notEqual(bao.as("root", "read", ESO_ROLE)[0], 0, "the apply created the role");
});
