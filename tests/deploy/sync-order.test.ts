// CR-D1-SECRETS-SYNC acceptance: the rollout does not start the ranker
// Deployment until every secret it reads has synced.
//
// Once the service refuses to boot without its secrets (CR-D1-SECRETS-BOOT),
// a pod that starts before its kv/corpus-ranker ExternalSecrets sync would
// crash-loop. Argo CD orders one sync by phase and then by the
// `argocd.argoproj.io/sync-wave` annotation, and does not start a wave until
// every resource in the earlier waves is healthy; its built-in ExternalSecret
// health check reports Healthy only once the ExternalSecret's Ready condition
// is True. So it is enough, and checked here purely on the rendered overlay
// (never against a deployed system), that every Secret the Deployment reads
// is materialised by an ExternalSecret that syncs as a regular (non-hook)
// resource in an earlier wave than the Deployment. That includes the database
// secret drawn from CR-D1-DBPASS's in-cluster Password generator, whose
// generator in turn precedes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderObjects, type K8sObject } from "./render.ts";

const WAVE = "argocd.argoproj.io/sync-wave";
const HOOK = "argocd.argoproj.io/hook";
const DB_ENV = "RANKER_DATABASE_URL";
const DB_GENERATOR = { kind: "Password", name: "ranker-db-password" };

const id = (o: K8sObject): string => `${o.kind}/${o.metadata.name}`;

/** The wave of a resource Argo applies in the Sync phase; hooks are not health-gated by wave and are refused. */
function syncWave(o: K8sObject): number {
  const annotations = o.metadata.annotations ?? {};
  assert.equal(annotations[HOOK], undefined, `${id(o)} must sync as a regular resource, not an Argo CD hook`);
  const raw = annotations[WAVE];
  assert.ok(raw !== undefined, `${id(o)} carries no ${WAVE} annotation`);
  assert.match(String(raw), /^-?\d+$/, `${id(o)} has a non-integer sync wave ${raw}`);
  return Number(raw);
}

type Read = { secret: string; via: string };

/** Every Secret a pod spec reads: env, envFrom, secret and projected volumes, image pull Secrets. */
function secretsRead(podSpec: Record<string, any>): Read[] {
  const reads: Read[] = [];
  for (const field of ["initContainers", "containers", "ephemeralContainers"]) {
    for (const c of (podSpec[field] ?? []) as Array<Record<string, any>>) {
      for (const e of (c.env ?? []) as Array<Record<string, any>>) {
        const ref = e.valueFrom?.secretKeyRef;
        if (ref) reads.push({ secret: ref.name, via: `${field}[${c.name}].env[${e.name}]` });
      }
      for (const e of (c.envFrom ?? []) as Array<Record<string, any>>) {
        if (e.secretRef) reads.push({ secret: e.secretRef.name, via: `${field}[${c.name}].envFrom` });
      }
    }
  }
  for (const v of (podSpec.volumes ?? []) as Array<Record<string, any>>) {
    if (v.secret) reads.push({ secret: v.secret.secretName, via: `volumes[${v.name}]` });
    for (const s of (v.projected?.sources ?? []) as Array<Record<string, any>>) {
      if (s.secret) reads.push({ secret: s.secret.name, via: `volumes[${v.name}].projected` });
    }
  }
  for (const p of (podSpec.imagePullSecrets ?? []) as Array<Record<string, any>>) {
    reads.push({ secret: p.name, via: "imagePullSecrets" });
  }
  return reads;
}

test("every ExternalSecret the rendered ranker Deployment reads is in an earlier Argo CD sync wave than the Deployment", () => {
  const objects = renderObjects();
  const deployments = objects.filter((o) => o.kind === "Deployment");
  assert.ok(
    deployments.some((d) => d.metadata.name === "ranker-api"),
    "the ranker Deployment ranker-api is not rendered",
  );
  const externalSecrets = objects.filter((o) => o.kind === "ExternalSecret");
  const target = (es: K8sObject): string => es.spec?.target?.name ?? es.metadata.name;

  let dbChecked = false;
  for (const deployment of deployments) {
    const deploymentWave = syncWave(deployment);
    const reads = secretsRead(deployment.spec?.template?.spec ?? {});
    assert.ok(reads.length > 0, `${id(deployment)} reads no Secret`);

    for (const { secret, via } of reads) {
      assert.equal(
        objects.filter((o) => o.kind === "Secret" && o.metadata.name === secret).length,
        0,
        `${id(deployment)} reads Secret ${secret} (${via}), which is rendered from git instead of synced`,
      );
      const sources = externalSecrets.filter((es) => target(es) === secret);
      assert.equal(sources.length, 1, `${id(deployment)} reads Secret ${secret} (${via}): want exactly one ExternalSecret, found ${sources.length}`);
      const es = sources[0]!;
      const wave = syncWave(es);
      assert.ok(
        wave < deploymentWave,
        `${id(es)} (wave ${wave}) must sync before ${id(deployment)} (wave ${deploymentWave}), which reads it via ${via}`,
      );

      if (via.endsWith(`.env[${DB_ENV}]`)) {
        // The database secret: drawn from the in-cluster Password generator, which itself syncs first.
        const refs = ((es.spec?.dataFrom ?? []) as Array<Record<string, any>>)
          .map((d) => d.sourceRef?.generatorRef)
          .filter(Boolean);
        assert.ok(
          refs.some((r) => r.kind === DB_GENERATOR.kind && r.name === DB_GENERATOR.name),
          `${id(es)} must draw on the ${DB_GENERATOR.kind} generator ${DB_GENERATOR.name}`,
        );
        const generator = objects.find(
          (o) => o.apiVersion.startsWith("generators.external-secrets.io/") && o.kind === DB_GENERATOR.kind && o.metadata.name === DB_GENERATOR.name,
        );
        assert.ok(generator, `the ${DB_GENERATOR.kind} generator ${DB_GENERATOR.name} is not rendered`);
        assert.ok(syncWave(generator) < wave, `${id(generator)} must sync before ${id(es)}`);
        dbChecked = true;
      }
    }
  }
  assert.ok(dbChecked, `no Deployment reads ${DB_ENV} from a Secret`);
});
