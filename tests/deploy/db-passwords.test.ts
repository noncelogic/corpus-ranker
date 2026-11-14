// CR-D1-DBPASS acceptance: the two ranker database role passwords declared
// by CR-D1-DB (ranker_migrator, the initdb owner; ranker_service, the managed
// role) are generated once, in-cluster, by an External Secrets Password
// generator with refresh disabled, so the first Argo sync needs no password
// written into OpenBao by hand and the passwords never rotate by themselves.
// The API keys stay custodied in OpenBao; only the database passwords change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findObject, renderObjects, type K8sObject } from "./render.ts";

const GENERATOR_API = "generators.external-secrets.io/v1alpha1";

/** The ExternalSecret materialising Secret `secretName`. */
function externalSecretFor(secretName: string): K8sObject {
  const matches = renderObjects().filter((o) => o.kind === "ExternalSecret" && (o.spec?.target?.name ?? o.metadata.name) === secretName);
  assert.equal(matches.length, 1, `exactly one ExternalSecret must materialise Secret ${secretName}`);
  return matches[0]!;
}

/** ESO treats a zero refresh interval as "never refresh". */
const isZeroDuration = (v: unknown): boolean => v === 0 || (typeof v === "string" && /^0+(?:\.0+)?(?:ns|us|µs|ms|s|m|h)?$/.test(v));

test("each ranker database role secret in the rendered manifests comes from a non-refreshing Password generator, and no database password is read from an OpenBao path", () => {
  const cluster = findObject("Cluster", "ranker-db");
  const roleSecrets: Array<[string, string]> = [
    [cluster.spec.bootstrap.initdb.secret?.name, "ranker_migrator"],
    ...(cluster.spec.managed?.roles ?? []).map((r: { name: string; passwordSecret?: { name: string } }): [string, string] => [r.passwordSecret?.name as string, r.name]),
  ];
  assert.deepEqual(
    roleSecrets,
    [
      ["ranker-db-migrator", "ranker_migrator"],
      ["ranker-db-service", "ranker_service"],
    ],
    "the CNPG owner bootstrap secret and managed-role secret are the two role secrets",
  );

  const generatorsSeen = new Set<string>();
  for (const [secretName, role] of roleSecrets) {
    const es = externalSecretFor(secretName);

    // Refresh disabled: generated once, never regenerated on a timer.
    assert.ok(isZeroDuration(es.spec.refreshInterval), `${secretName} refreshInterval must be 0 (got ${JSON.stringify(es.spec.refreshInterval)})`);
    if (es.spec.refreshPolicy !== undefined) {
      assert.notEqual(es.spec.refreshPolicy, "Periodic", `${secretName} must not refresh periodically`);
    }

    // No OpenBao (or any SecretStore) input at all: no store, no remoteRefs,
    // and every dataFrom entry is a generator reference.
    assert.equal(es.spec.secretStoreRef, undefined, `${secretName} must not read from a SecretStore`);
    assert.equal(es.spec.data, undefined, `${secretName} must not read remote keys`);
    const sources: Array<Record<string, any>> = es.spec.dataFrom ?? [];
    assert.equal(sources.length, 1, `${secretName} must have exactly one generated source`);
    const ref = sources[0]!.sourceRef?.generatorRef;
    assert.ok(ref, `${secretName} dataFrom must reference a generator`);
    assert.equal(sources[0]!.sourceRef.storeRef, undefined, `${secretName} must not use a store`);
    assert.equal(sources[0]!.extract, undefined);
    assert.equal(sources[0]!.find, undefined);
    assert.equal(ref.apiVersion, GENERATOR_API);
    assert.equal(ref.kind, "Password", `${secretName} must use a Password generator`);

    const gen = findObject("Password", ref.name);
    assert.equal(gen.apiVersion, GENERATOR_API);
    assert.equal(gen.metadata.namespace, "corpus-ranker", "the generator lives beside the ExternalSecret");
    assert.ok(typeof gen.spec?.length === "number" && gen.spec.length >= 32, `Password/${ref.name} must generate at least 32 characters`);
    generatorsSeen.add(ref.name);

    // The generated value (key `password`) lands in a basic-auth Secret CNPG accepts.
    const tmpl = es.spec.target?.template;
    assert.equal(tmpl?.type, "kubernetes.io/basic-auth", `${secretName} must be basic-auth for CNPG`);
    assert.equal(tmpl.data.username, role);
    assert.match(tmpl.data.password, /^\{\{\s*\.password\s*\}\}$/);
    assert.equal(tmpl.metadata?.labels?.["cnpg.io/reload"], "true");
    // Owned by the ExternalSecret but kept if it is ever deleted, so a
    // re-sync never silently swaps a role's password underneath CNPG.
    assert.equal(es.spec.target.creationPolicy ?? "Owner", "Owner");
    assert.equal(es.spec.target.deletionPolicy ?? "Retain", "Retain");
  }
  assert.ok(generatorsSeen.size > 0);

  // Nothing database-related is fetched from OpenBao any more.
  for (const es of renderObjects().filter((o) => o.kind === "ExternalSecret" && o.spec?.secretStoreRef)) {
    const remoteKeys = [
      ...(es.spec.data ?? []).map((d: { remoteRef?: { key?: string } }) => d.remoteRef?.key),
      ...(es.spec.dataFrom ?? []).map((d: { extract?: { key?: string } }) => d.extract?.key),
    ];
    for (const key of remoteKeys) {
      assert.doesNotMatch(String(key), /\bdb\b|database|postgres|migrator|service/i, `${es.metadata.name} reads a database password from OpenBao path ${key}`);
    }
    assert.doesNotMatch(JSON.stringify(es.spec.target ?? {}), /ranker-db-|ranker_migrator|ranker_service/, `${es.metadata.name} feeds a database secret from OpenBao`);
  }

  // The API keys stay custodied in OpenBao (CR-D1-SECRETS).
  const apiKeys = externalSecretFor("ranker-api-keys");
  assert.deepEqual(apiKeys.spec.secretStoreRef, { kind: "ClusterSecretStore", name: "openbao" });
  assert.deepEqual(apiKeys.spec.dataFrom, [{ extract: { key: "corpus-ranker/api-keys" } }]);
});
