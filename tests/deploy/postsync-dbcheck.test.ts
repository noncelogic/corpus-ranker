// CR-D1-DBCHECK acceptance: every Argo sync ends with a PostSync hook Job
// that logs in to the ranker's CNPG cluster, through its read-write Service,
// with each in-cluster generated role secret (CR-D1-DBPASS), and fails the
// sync when a secret is missing or a login is refused.
//
// The first test reads the rendered overlay; the second runs the Job's own
// script (deploy/db/dbcheck.sh, shipped as a ConfigMap) against a real
// Postgres from the compose replica, with the Job's arguments and secret
// layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deployDir, findObject, renderObjects, type K8sObject } from "./render.ts";
import { freshDatabase } from "../schema/fresh-db.ts";

const GENERATOR_API = "generators.external-secrets.io/v1alpha1";
const DB = "ranker_estate";

interface EnvVar {
  name: string;
  value?: string;
}

/** Secrets materialised from an in-cluster Password generator: the generated ranker role secrets. */
function generatedRoleSecrets(): Array<{ secret: string; username: string }> {
  return renderObjects()
    .filter(
      (o) =>
        o.kind === "ExternalSecret" &&
        (o.spec?.dataFrom ?? []).some(
          (d: { sourceRef?: { generatorRef?: { apiVersion: string; kind: string } } }) =>
            d.sourceRef?.generatorRef?.apiVersion === GENERATOR_API && d.sourceRef.generatorRef.kind === "Password",
        ),
    )
    .map((es) => ({ secret: es.spec.target?.name ?? es.metadata.name, username: es.spec.target.template.data.username }));
}

function dbCheckJob(): K8sObject {
  const hooks = renderObjects().filter(
    (o) =>
      o.kind === "Job" &&
      String(o.metadata.annotations?.["argocd.argoproj.io/hook"] ?? "")
        .split(",")
        .map((h) => h.trim())
        .includes("PostSync"),
  );
  assert.equal(hooks.length, 1, "exactly one PostSync hook Job is rendered");
  return hooks[0]!;
}

const envOf = (container: { env?: EnvVar[] }): Record<string, string> =>
  Object.fromEntries((container.env ?? []).filter((e) => e.value !== undefined).map((e) => [e.name, e.value!]));

test("the rendered manifests include a PostSync hook Job that reads every generated ranker role secret and targets the CNPG read-write service", () => {
  const job = dbCheckJob();
  assert.equal(job.metadata.name, "ranker-db-check");
  assert.equal(job.metadata.namespace, "corpus-ranker");
  // Re-created on every sync, the previous run's pod kept for its logs until then.
  assert.equal(job.metadata.annotations?.["argocd.argoproj.io/hook-delete-policy"], "BeforeHookCreation");

  const pod = job.spec.template.spec;
  assert.equal(pod.restartPolicy, "Never");
  assert.equal(pod.containers.length, 1);
  const c = pod.containers[0]!;
  const env = envOf(c);

  // Targets the CNPG cluster's read-write Service and the ranker database.
  const cluster = findObject("Cluster", "ranker-db");
  assert.match(env.PGHOST ?? "", new RegExp(`^${cluster.metadata.name}-rw(\\.corpus-ranker(\\.svc(\\.cluster\\.local)?)?)?$`));
  assert.equal(env.PGPORT, "5432");
  assert.equal(env.PGDATABASE, cluster.spec.bootstrap.initdb.database);
  assert.equal(env.PGSSLMODE, "require");
  // psql comes from the same CNPG Postgres image the cluster runs.
  assert.equal(c.image, cluster.spec.imageName);

  // Every generated role secret is mounted where the script reads it, and
  // named as one of the script's arguments.
  const roles = generatedRoleSecrets();
  assert.deepEqual(
    roles.map((r) => r.secret).sort(),
    ["ranker-db-migrator", "ranker-db-service"],
    "both CNPG role secrets are generated in-cluster",
  );
  const secretsDir = env.DBCHECK_SECRETS_DIR ?? "/secrets";
  const args: string[] = [...(c.command ?? []), ...(c.args ?? [])];
  for (const { secret } of roles) {
    assert.ok(args.includes(secret), `the check is not given ${secret}`);
    const volume = (pod.volumes ?? []).find((v: { secret?: { secretName: string } }) => v.secret?.secretName === secret);
    assert.ok(volume, `the Job does not mount Secret ${secret}`);
    // Optional, so a missing Secret fails the check instead of stalling the pod.
    assert.equal(volume.secret.optional, true, `${secret} must be mounted optional`);
    const mount = (c.volumeMounts ?? []).find((m: { name: string }) => m.name === volume.name);
    assert.equal(mount?.mountPath, `${secretsDir}/${secret}`, `${secret} mount path`);
  }
  // Nothing else: no superuser or other credentials.
  assert.doesNotMatch(JSON.stringify(job), /superuser|ranker-api-keys|ranker-minio/);

  // It runs deploy/db/dbcheck.sh, shipped verbatim as a ConfigMap.
  assert.match(args.join(" "), /dbcheck\.sh/);
  const scripts = (pod.volumes ?? []).find((v: { configMap?: { name: string } }) => v.configMap);
  assert.ok(scripts, "the Job mounts no ConfigMap with the check script");
  assert.equal(findObject("ConfigMap", scripts.configMap.name).data["dbcheck.sh"], readFileSync(resolve(deployDir, "db", "dbcheck.sh"), "utf8"));
});

test("the db check exits non-zero when a role secret is absent or its login is refused, and zero when every role logs in", { timeout: 600_000 }, async (t) => {
  const db = await freshDatabase(t, { migrate: false });
  const job = dbCheckJob();
  const c = job.spec.template.spec.containers[0]!;
  const secretArgs: string[] = (c.args ?? []).filter((a: string) => a.startsWith("ranker-db-"));
  const roles = generatedRoleSecrets();
  assert.deepEqual([...secretArgs].sort(), roles.map((r) => r.secret).sort());

  // The roles exist as CNPG creates them, each with its generated password.
  const passwords = new Map(roles.map((r, i) => [r.secret, `generated-${i}-pw`]));
  db.psql(roles.map((r) => `CREATE ROLE ${r.username} LOGIN PASSWORD '${passwords.get(r.secret)}';`).join("\n"));
  db.psql(`CREATE DATABASE ${DB} OWNER ${roles[0]!.username};`);

  db.writeFile("/tmp/scripts/dbcheck.sh", readFileSync(resolve(deployDir, "db", "dbcheck.sh"), "utf8"));
  const writeSecret = (secret: string, username: string, password: string): void => {
    db.writeFile(`/tmp/secrets/${secret}/username`, username);
    db.writeFile(`/tmp/secrets/${secret}/password`, password);
  };
  for (const r of roles) writeSecret(r.secret, r.username, passwords.get(r.secret)!);

  // The Job's own environment, pointed at the local replica (no TLS there).
  // PGHOST is set per run to the container's network address: the replica
  // trusts 127.0.0.1 without a password, its other addresses require one.
  const { PGHOST: _, ...jobEnv } = envOf(c);
  const env: Record<string, string> = {
    ...jobEnv,
    PGDATABASE: DB,
    PGSSLMODE: "disable",
    DBCHECK_SECRETS_DIR: "/tmp/secrets",
    DBCHECK_WAIT_SECONDS: "1",
  };
  const check = (): { code: number; output: string } => {
    const out = db.sh(`PGHOST=$(hostname -i | cut -d' ' -f1) sh /tmp/scripts/dbcheck.sh ${secretArgs.join(" ")} 2>&1; echo "exit=$?"`, env);
    const m = /exit=(\d+)\s*$/.exec(out);
    assert.ok(m, out);
    return { code: Number(m[1]), output: out };
  };

  // Every role logs in: success.
  const ok = check();
  assert.equal(ok.code, 0, ok.output);
  for (const r of roles) assert.match(ok.output, new RegExp(`ok ${r.secret}: logged in as ${r.username}`));

  // A role's login refused (its password no longer matches): failure.
  const [first, second] = roles as [(typeof roles)[0], (typeof roles)[0]];
  writeSecret(second.secret, second.username, "not-the-password");
  const refused = check();
  assert.notEqual(refused.code, 0, refused.output);
  assert.match(refused.output, new RegExp(`FAIL ${second.secret}: login as ${second.username} refused`));
  assert.match(refused.output, new RegExp(`ok ${first.secret}`));
  writeSecret(second.secret, second.username, passwords.get(second.secret)!);
  assert.equal(check().code, 0);

  // A role that may not log in at all: failure.
  db.psql(`ALTER ROLE ${first.username} NOLOGIN;`);
  const nologin = check();
  assert.notEqual(nologin.code, 0, nologin.output);
  assert.match(nologin.output, new RegExp(`FAIL ${first.secret}: login as ${first.username} refused`));
  db.psql(`ALTER ROLE ${first.username} LOGIN;`);
  assert.equal(check().code, 0);

  // A role secret absent (the optional volume mounted empty): failure.
  db.sh(`rm -rf /tmp/secrets/${first.secret} && mkdir -p /tmp/secrets/${first.secret}`);
  const missing = check();
  assert.notEqual(missing.code, 0, missing.output);
  assert.match(missing.output, new RegExp(`FAIL ${first.secret}: secret missing`));
  assert.match(missing.output, new RegExp(`ok ${second.secret}`));
});
