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
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderObjects, repoRoot, type K8sObject } from "./render.ts";
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
const NON_DB_EXTERNAL_SECRETS = ["ranker-minio-service", "ranker-api-keys", "ranker-ghcr-pull"];

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

// CR-D1-PULL-D2 acceptance: the ranker's own pull-only GHCR credential
// (registry-credential-per-product; Rule: policies/placement-defaults.yaml#credentials)
// lives at kv/corpus-ranker/ghcr-pull, written by the DevOps route with
// deploy/openbao/store-ghcr-pull.sh (never echoed, presence checked by name
// only), and the estate External Secrets role reads that one exact path,
// read-only, through deploy/openbao/external-secrets-ghcr-pull.hcl.
test("the ranker's image pull secret is an ExternalSecret sourced from kv/corpus-ranker/ghcr-pull", (t) => {
  const objs = renderObjects();
  const api = find(objs, "Deployment", "ranker-api");
  const pullSecrets = ((api.spec.template.spec.imagePullSecrets ?? []) as Array<{ name: string }>).map((s) => s.name);
  assert.deepEqual(pullSecrets, ["ranker-ghcr-pull"], "the API pulls with the ranker's own pull secret only");
  const es = externalSecretFor(objs, "ranker-ghcr-pull");
  assertFromOpenBao(es);
  assert.equal(es.spec.target.template?.type, "kubernetes.io/dockerconfigjson");
  const keys = new Set((es.spec.data as Array<{ remoteRef: { key: string } }>).map((d) => d.remoteRef.key));
  assert.deepEqual([...keys], ["corpus-ranker/ghcr-pull"], "the pull secret reads kv/corpus-ranker/ghcr-pull and nothing else");

  // The estate External Secrets role: one exact path, read-only, no wildcard, no metadata.
  const policy = readFileSync(resolve(repoRoot, "deploy", "openbao", "external-secrets-ghcr-pull.hcl"), "utf8").replace(/#.*$/gm, "");
  const stanzas = [...policy.matchAll(/path\s+"([^"]+)"\s*\{\s*capabilities\s*=\s*\[([^\]]*)\]\s*\}/g)].map((m) => ({
    path: m[1],
    caps: m[2]!.split(",").map((c) => c.trim().replace(/"/g, "")).filter(Boolean),
  }));
  assert.deepEqual(stanzas, [{ path: "kv/data/corpus-ranker/ghcr-pull", caps: ["read"] }], "the ESO role reads exactly kv/corpus-ranker/ghcr-pull, read-only");
  assert.equal((policy.match(/\bpath\b/g) ?? []).length, 1, "the policy grants no other path");
  assert.doesNotMatch(policy, /[*+]/, "no wildcard grants");

  // The DevOps route stores it: token from stdin, never echoed, never overwriting.
  const script = resolve(repoRoot, "deploy", "openbao", "store-ghcr-pull.sh");
  const bin = mkdtempSync(join(tmpdir(), "fake-bao-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  // A stand-in `bao` logging each call; `kv metadata get` succeeds unless FAKE_BAO_ABSENT is set.
  writeFileSync(
    join(bin, "bao"),
    `#!/bin/sh\necho "$*" >> "${bin}/calls"\ncase "$2" in put) cat > "${bin}/stdin" ;; esac\necho "== Secret Path ==" ; echo "kv/data/corpus-ranker/ghcr-pull"\nif [ "$2" = metadata ] && [ -n "\${FAKE_BAO_ABSENT:-}" ]; then exit 2; fi\nexit "\${FAKE_BAO_EXIT:-0}"\n`,
  );
  chmodSync(join(bin, "bao"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const token = "ghp_" + "Z".repeat(36);

  const run = spawnSync(script, ["store", "noncelogic-ranker-pull"], { env, input: `${token}\n`, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const calls = readFileSync(join(bin, "calls"), "utf8").trim().split("\n");
  assert.deepEqual(calls, ["kv put -mount=kv -cas=0 corpus-ranker/ghcr-pull -", "kv metadata get -mount=kv corpus-ranker/ghcr-pull"]);
  assert.deepEqual(JSON.parse(readFileSync(join(bin, "stdin"), "utf8")), { username: "noncelogic-ranker-pull", token });
  assert.ok(!run.stdout.includes(token) && !run.stderr.includes(token), "the script echoed the token");
  assert.ok(!calls.join(" ").includes(token), "the token went on argv");
  assert.doesNotMatch(run.stdout + run.stderr, /Secret Path/, "the bao CLI's output is not passed through");
  assert.match(run.stderr, /present: kv\/corpus-ranker\/ghcr-pull/);

  // Presence is checked by name (metadata) only, never by reading the value.
  rmSync(join(bin, "calls"));
  const check = spawnSync(script, ["check"], { env, encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  assert.deepEqual(readFileSync(join(bin, "calls"), "utf8").trim().split("\n"), ["kv metadata get -mount=kv corpus-ranker/ghcr-pull"]);
  assert.notEqual(spawnSync(script, ["check"], { env: { ...env, FAKE_BAO_ABSENT: "1" }, encoding: "utf8" }).status, 0, "an absent credential must fail the check");

  // Refusals: no/odd user, empty or malformed token, a failed write.
  for (const [args, input] of [[["store"], `${token}\n`], [["store", "Bad User"], `${token}\n`], [["store", "u"], ""], [["store", "u"], "not a token\n"], [["bogus"], ""]] as const) {
    assert.notEqual(spawnSync(script, [...args], { env, input, encoding: "utf8" }).status, 0, `accepted ${JSON.stringify(args)}`);
  }
  assert.notEqual(spawnSync(script, ["store", "u"], { env: { ...env, FAKE_BAO_EXIT: "2" }, input: `${token}\n`, encoding: "utf8" }).status, 0);

  const text = readFileSync(script, "utf8");
  assert.match(text, /^#!\/bin\/sh\n/);
  assert.doesNotMatch(text, /set -[a-z]*x|set -o xtrace/);
  execFileSync("sh", ["-n", script]);
});

// CR-D1-SECRETS-ROLLOUT acceptance (CRANK-140; Rule: policies/placement-defaults.yaml#estate
// secrets): the API key and object-store ExternalSecrets read only
// kv/corpus-ranker/api-keys and kv/corpus-ranker/minio, and the estate External
// Secrets role's policy for them, deploy/openbao/external-secrets-corpus-ranker.hcl,
// grants exactly those two paths, read-only, with no wildcard. Loaded into a
// throwaway OpenBao, a token holding that policy alone reads both and nothing else.
const ESO_POLICY = "external-secrets-corpus-ranker";
const API_KEY_AND_OBJECT_STORE = ["ranker-api-keys", "ranker-minio", "ranker-minio-service"];
const ESO_PATHS = ["corpus-ranker/api-keys", "corpus-ranker/minio"];

/** Every OpenBao path an ExternalSecret reads. */
const remotePaths = (es: K8sObject): string[] => [
  ...(es.spec.data ?? []).map((d: { remoteRef?: { key?: string } }) => d.remoteRef?.key),
  ...(es.spec.dataFrom ?? []).map((d: { extract?: { key?: string } }) => d.extract?.key),
];

test("the API key and object-store ExternalSecrets read only kv/corpus-ranker/api-keys and kv/corpus-ranker/minio, and the External Secrets role's policy grants exactly those, read-only", { timeout: 300_000 }, async (t) => {
  const objs = renderObjects();
  const read = new Set<string>();
  for (const name of API_KEY_AND_OBJECT_STORE) {
    const es = externalSecretFor(objs, name);
    assertFromOpenBao(es);
    for (const d of es.spec.dataFrom ?? []) assert.equal(d.find, undefined, `${name} must not search OpenBao`);
    for (const path of remotePaths(es)) {
      assert.ok(ESO_PATHS.includes(path), `ExternalSecret/${name} reads ${path}, not kv/corpus-ranker/api-keys or kv/corpus-ranker/minio`);
      read.add(path);
    }
  }
  assert.deepEqual([...read].sort(), ESO_PATHS, "both paths are read");
  assert.deepEqual(remotePaths(externalSecretFor(objs, "ranker-api-keys")), ["corpus-ranker/api-keys"]);
  assert.deepEqual(new Set([...remotePaths(externalSecretFor(objs, "ranker-minio")), ...remotePaths(externalSecretFor(objs, "ranker-minio-service"))]), new Set(["corpus-ranker/minio"]));

  // The recorded policy: two exact data paths, read only, nothing else.
  const policyFile = resolve(repoRoot, "deploy", "openbao", `${ESO_POLICY}.hcl`);
  const policy = readFileSync(policyFile, "utf8");
  assert.deepEqual(
    [...policyPaths(policy)].sort(),
    ESO_PATHS.map((p) => [`kv/data/${p}`, ["read"]]),
    "the External Secrets role reads exactly kv/corpus-ranker/api-keys and kv/corpus-ranker/minio, read-only",
  );
  assert.doesNotMatch(policy.replace(/#.*$/gm, ""), /[*+]/, "no wildcard grants");

  // Live: a token holding that policy alone (plus OpenBao's `default`) reads both paths and nothing else.
  const bao = await startDevOpenBao(t);
  docker(["cp", policyFile, `${bao.name}:/tmp/policy.hcl`]);
  bao.root("policy", "write", ESO_POLICY, "/tmp/policy.hcl");
  bao.root("kv", "put", "-mount=kv", "corpus-ranker/api-keys", "joe=api-secret");
  bao.root("kv", "put", "-mount=kv", "corpus-ranker/minio", "root-user=r", "root-password=p", "service-user=s", "service-password=q");
  bao.root("kv", "put", "-mount=kv", "corpus-ranker/ghcr-pull", "username=u", "token=t");
  bao.root("kv", "put", "-mount=kv", "other-product/api-keys", "x=y");
  const token = JSON.parse(bao.root("token", "create", "-format=json", `-policy=${ESO_POLICY}`)).auth.client_token as string;

  // The reads External Secrets makes for the three ExternalSecrets succeed.
  for (const path of ESO_PATHS) {
    const [code, out] = bao.as(token, "kv", "get", "-format=json", "-mount=kv", path);
    assert.equal(code, 0, `the ESO token must read kv/${path}: ${out}`);
  }
  const refused: string[][] = [
    ["kv", "put", "-mount=kv", "corpus-ranker/api-keys", "joe=x"],
    ["kv", "patch", "-mount=kv", "corpus-ranker/api-keys", "joe=x"],
    ["kv", "patch", "-mount=kv", "corpus-ranker/minio", "service-user=x"],
    ["kv", "delete", "-mount=kv", "corpus-ranker/minio"],
    ["kv", "list", "-mount=kv", "corpus-ranker"],
    ["kv", "metadata", "get", "-mount=kv", "corpus-ranker/api-keys"],
    ["kv", "get", "-mount=kv", "corpus-ranker/ghcr-pull"],
    ["kv", "get", "-mount=kv", "corpus-ranker/api-keys-old"],
    ["kv", "get", "-mount=kv", "other-product/api-keys"],
    ["policy", "list"],
  ];
  for (const args of refused) {
    const [code, out] = bao.as(token, ...args);
    assert.notEqual(code, 0, `the ESO token must not: bao ${args.join(" ")}\n${out}`);
    assert.match(out, /permission denied|403/i, `bao ${args.join(" ")} failed for another reason: ${out}`);
  }
  assert.equal(bao.root("kv", "get", "-mount=kv", "-field=joe", "corpus-ranker/api-keys").trim(), "api-secret", "the refused writes changed nothing");
});
