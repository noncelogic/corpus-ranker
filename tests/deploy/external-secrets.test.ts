// CR-D1-SECRETS acceptance: every secret the rendered ranker API Deployment
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
// deploy/openbao/generate-api-keys.sh, which never prints them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderObjects, repoRoot, type K8sObject } from "./render.ts";

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

/** The whole rule, over a set of rendered objects. */
function assertBootSecretsSourced(objs: K8sObject[]): void {
  const deployment = find(objs, "Deployment", "ranker-api");
  const podSpec = deployment.spec.template.spec;
  const secretEnv = new Map<string, string>();
  let mountsApiKeys = false;

  for (const c of containers(deployment)) {
    for (const ref of c.envFrom ?? []) {
      assert.equal(ref.configMapRef, undefined, `container ${c.name} loads env from a ConfigMap; secrets must not hide there`);
      assertFromOpenBao(externalSecretFor(objs, ref.secretRef?.name));
      assert.notEqual(ref.secretRef.optional, true, `container ${c.name} must not boot without Secret ${ref.secretRef.name}`);
    }
    for (const env of (c.env ?? []) as EnvVar[]) {
      const ref = env.valueFrom?.secretKeyRef;
      if (!ref) {
        assert.ok(!SECRETISH.test(env.name) || env.name === "RANKER_API_KEYS_DIR", `${env.name} looks secret but is not read from a Secret`);
        assert.equal(env.valueFrom, undefined, `${env.name} reads from something other than a Secret (${JSON.stringify(env.valueFrom)})`);
        continue;
      }
      assert.notEqual(ref.optional, true, `${env.name} must not be optional: the service needs it at boot`);
      const es = externalSecretFor(objs, ref.name);
      if (env.name === GENERATED_ENV) assertFromDbGenerator(objs, es);
      else assertFromOpenBao(es);
      assertProducesKey(es, ref.key);
      secretEnv.set(env.name, ref.name);
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

  for (const name of BOOT_SECRET_ENV) assert.ok(secretEnv.has(name), `the Deployment must read ${name} from a Secret`);
  assert.ok(mountsApiKeys, "the Deployment must set RANKER_API_KEYS_DIR to its mounted API key Secret");

  // The database URL's Secret is read by nothing else in the API, so the exception stays exact.
  const dbSecret = secretEnv.get(GENERATED_ENV)!;
  for (const [name, secret] of secretEnv) {
    if (name !== GENERATED_ENV) assert.notEqual(secret, dbSecret, `${name} must not read the generated database Secret ${dbSecret}`);
  }

  // Every secret volume and image pull Secret of the API is an OpenBao ExternalSecret too.
  for (const volume of podSpec.volumes ?? []) {
    const names: string[] = [
      ...(volume.secret ? [volume.secret.secretName] : []),
      ...(volume.projected?.sources ?? []).filter((s: Record<string, any>) => s.secret).map((s: Record<string, any>) => s.secret.name),
    ];
    for (const secretName of names) {
      assertFromOpenBao(externalSecretFor(objs, secretName));
      assert.notEqual(volume.secret?.optional, true, `volume ${volume.name} must not be optional`);
    }
  }
  for (const pull of podSpec.imagePullSecrets ?? []) assertFromOpenBao(externalSecretFor(objs, pull.name));

  // The API keys come straight from kv/corpus-ranker/api-keys, one property per principal.
  assert.deepEqual(externalSecretFor(objs, "ranker-api-keys").spec.dataFrom, [{ extract: { key: "corpus-ranker/api-keys" } }]);

  // Nothing secret is rendered from git.
  for (const o of objs) assert.notEqual(o.kind, "Secret", `Secret/${o.metadata.name} is rendered from git`);
}

/** A copy of the render with `edit` applied to ExternalSecret `name`. */
function withExternalSecret(name: string, edit: (spec: Record<string, any>) => void): K8sObject[] {
  const objs = structuredClone(renderObjects());
  edit(find(objs, "ExternalSecret", name).spec);
  return objs;
}

const generatorSource = (spec: Record<string, any>): void => {
  delete spec.secretStoreRef;
  delete spec.data;
  spec.dataFrom = [{ sourceRef: { generatorRef: { ...DB_GENERATOR } } }];
};

test("every secret the rendered ranker Deployment reads at boot is sourced from an OpenBao ExternalSecret under kv/corpus-ranker, except RANKER_DATABASE_URL, which only the non-refreshing ranker-db-password generator sources", () => {
  assertBootSecretsSourced(renderObjects());

  // The rule bites: a generator source for any other runtime secret is refused ...
  for (const name of ["ranker-minio-service", "ranker-api-keys", "ranker-ghcr-pull"]) {
    assert.throws(() => assertBootSecretsSourced(withExternalSecret(name, generatorSource)), /must read the estate OpenBao store/, `a generator-sourced ${name} was accepted`);
  }
  // ... as is OpenBao outside kv/corpus-ranker or another store,
  assert.throws(() => assertBootSecretsSourced(withExternalSecret("ranker-minio-service", (s) => (s.data[0].remoteRef.key = "other-app/minio"))));
  assert.throws(() => assertBootSecretsSourced(withExternalSecret("ranker-api-keys", (s) => (s.secretStoreRef = { kind: "SecretStore", name: "openbao" }))));
  // ... and the database URL from anything but the non-refreshing ranker-db-password generator.
  assert.throws(() => assertBootSecretsSourced(withExternalSecret("ranker-db-service", (s) => (s.refreshInterval = "1h"))));
  assert.throws(() => assertBootSecretsSourced(withExternalSecret("ranker-db-service", (s) => (s.dataFrom[0].sourceRef.generatorRef.name = "other-password"))));
  assert.throws(() =>
    assertBootSecretsSourced(
      withExternalSecret("ranker-db-service", (s) => {
        s.secretStoreRef = { kind: "ClusterSecretStore", name: "openbao" };
        s.dataFrom = [{ extract: { key: "corpus-ranker/db" } }];
      }),
    ),
  );
});

test("deploy/openbao/generate-api-keys.sh writes one fresh key per principal to kv/corpus-ranker/api-keys without echoing any", (t) => {
  const script = resolve(repoRoot, "deploy", "openbao", "generate-api-keys.sh");
  const bin = mkdtempSync(join(tmpdir(), "fake-bao-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  // A stand-in `bao` that records its arguments and stdin, and prints what the real CLI would.
  writeFileSync(
    join(bin, "bao"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${bin}/args"\ncat > "${bin}/stdin"\necho "== Secret Path ==" ; echo "kv/data/corpus-ranker/api-keys"\nexit "\${FAKE_BAO_EXIT:-0}"\n`,
  );
  chmodSync(join(bin, "bao"), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };

  const run = spawnSync(script, ["juno", "hermes", "joe"], { env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);

  const args = readFileSync(join(bin, "args"), "utf8").trim().split("\n");
  assert.deepEqual(args, ["kv", "put", "-mount=kv", "-cas=0", "corpus-ranker/api-keys", "-"], "keys go to kv/corpus-ranker/api-keys, never overwriting an existing set");
  const written = JSON.parse(readFileSync(join(bin, "stdin"), "utf8")) as Record<string, string>;
  assert.deepEqual(Object.keys(written).sort(), ["hermes", "joe", "juno"]);
  const keys = Object.values(written);
  for (const key of keys) assert.match(key, /^[0-9a-f]{64}$/, "each key is 256 random bits, hex");
  assert.equal(new Set(keys).size, keys.length, "every principal gets its own key");
  for (const key of keys) {
    assert.ok(!run.stdout.includes(key) && !run.stderr.includes(key), "the script echoed an API key");
  }
  assert.doesNotMatch(run.stdout + run.stderr, /Secret Path/, "the bao CLI's output is not passed through");

  // Bad principal names, duplicates and a failing write are all refusals.
  for (const bad of [[], ["Juno"], ["../x"], ["juno", "juno"]]) {
    assert.notEqual(spawnSync(script, bad, { env, encoding: "utf8" }).status, 0, `accepted principals ${JSON.stringify(bad)}`);
  }
  const failed = spawnSync(script, ["juno"], { env: { ...env, FAKE_BAO_EXIT: "2" }, encoding: "utf8" });
  assert.notEqual(failed.status, 0, "a failed OpenBao write must fail the script");

  // The script is POSIX sh and never traces (which would print the keys).
  const text = readFileSync(script, "utf8");
  assert.match(text, /^#!\/bin\/sh\n/);
  assert.doesNotMatch(text, /set -[a-z]*x|set -o xtrace/);
  execFileSync("sh", ["-n", script]);
});
