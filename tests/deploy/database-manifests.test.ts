// CR-D1-DB acceptance: the deploy overlay declares the ranker's CNPG cluster
// on aks-obs-01 with role ownership split in two (TECH-STACK §2):
//   - ranker_migrator: the database owner, owns the schema and every object
//     in it, and is the only role the migrations run as;
//   - ranker_service: the service's login role, a member of the ranker_app
//     grant role (db/migrations), so it can write but never UPDATE or DELETE
//     score events.
// An Argo CD PreSync Job applies the merged migrations (db/migrations, baked
// into the API image) as the migrator before the service is rolled out.
//
// The live-Postgres half of this contract is tests/schema/service-role-grants.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deployDir, findObject, parseYamlDocs, renderObjects, repoRoot, type K8sObject } from "./render.ts";

const MIGRATOR = "ranker_migrator";
const SERVICE = "ranker_service";
const APP_GRANT_ROLE = "ranker_app";
const API_IMAGE = "ghcr.io/noncelogic/corpus-ranker";

interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef?: { name: string; key: string } };
}

const env = (container: { env?: EnvVar[] }, name: string): EnvVar => {
  const v = (container.env ?? []).find((e) => e.name === name);
  assert.ok(v, `container has no env ${name}`);
  return v;
};
const secretRef = (container: { env?: EnvVar[] }, name: string): { name: string; key: string } => {
  const ref = env(container, name).valueFrom?.secretKeyRef;
  assert.ok(ref, `env ${name} is not read from a Secret`);
  return ref;
};

/** The ExternalSecret materialising `secretName`, with its rendered template data. */
function externalSecretFor(secretName: string): K8sObject {
  const es = renderObjects().find((o) => o.kind === "ExternalSecret" && (o.spec?.target?.name ?? o.metadata.name) === secretName);
  assert.ok(es, `no ExternalSecret materialises Secret ${secretName}`);
  assert.deepEqual(es.spec.secretStoreRef, { kind: "ClusterSecretStore", name: "openbao" });
  return es;
}

test("the YAML reader used by these tests parses the source manifests", () => {
  // Guards the dependency-free reader against the shapes deploy/ uses.
  const [cluster] = parseYamlDocs(readFileSync(resolve(deployDir, "database.yaml"), "utf8")) as K8sObject[];
  assert.equal(cluster!.kind, "Cluster");
  assert.equal(cluster!.spec.bootstrap.initdb.owner, MIGRATOR);
  const docs = parseYamlDocs("a:\n- b: 1\n  c: [x, \"y\"]\n- |\n  l1\n  l2\nd: {e: f}\n# c\n---\nk: 'it''s'\n");
  assert.deepEqual(docs, [{ a: [{ b: 1, c: ["x", "y"] }, "l1\nl2\n"], d: { e: "f" } }, { k: "it's" }]);
});

test("the rendered overlay declares the ranker CNPG cluster with separate migrator and service roles and a pre-sync migration Job run as the migrator", () => {
  // --- The CNPG cluster: the migrator owns the database (and so the schema).
  const cluster = findObject("Cluster", "ranker-db");
  assert.equal(cluster.apiVersion, "postgresql.cnpg.io/v1");
  assert.equal(cluster.metadata.namespace, "corpus-ranker");
  const initdb = cluster.spec.bootstrap.initdb;
  assert.equal(initdb.database, "ranker");
  assert.equal(initdb.owner, MIGRATOR, "the migrator role must own the ranker database");
  assert.equal(initdb.secret?.name, "ranker-db-migrator", "the owner's credentials come from the migrator secret");
  assert.equal(cluster.spec.enableSuperuserAccess ?? false, false, "no superuser credentials are exposed");

  // Bootstrap SQL (run by CNPG as superuser in the ranker database) hands the
  // public schema to the migrator and creates the NOLOGIN grant role.
  const refs: Array<{ name: string; key: string }> = initdb.postInitApplicationSQLRefs?.configMapRefs ?? [];
  const bootstrapSql = refs
    .map((ref) => {
      const cm = findObject("ConfigMap", ref.name);
      const sql = cm.data?.[ref.key];
      assert.equal(typeof sql, "string", `ConfigMap/${ref.name} has no key ${ref.key}`);
      return sql as string;
    })
    .join("\n");
  assert.match(bootstrapSql, new RegExp(`ALTER SCHEMA public OWNER TO ${MIGRATOR}\\b`, "i"));
  assert.match(bootstrapSql, new RegExp(`CREATE ROLE ${APP_GRANT_ROLE} NOLOGIN`, "i"));
  assert.equal(bootstrapSql, readFileSync(resolve(deployDir, "db", "bootstrap.sql"), "utf8"));

  // Managed roles: exactly one, the service login role, unprivileged and a
  // member of the grant role. The migrator is not re-declared here.
  const roles: Array<Record<string, unknown>> = cluster.spec.managed?.roles ?? [];
  assert.deepEqual(roles.map((r) => r.name), [SERVICE], "the service role is the only managed (application) role");
  const service = roles[0]!;
  assert.equal(service.ensure ?? "present", "present");
  assert.equal(service.login, true);
  assert.equal(service.inherit ?? true, true, "the service role must inherit ranker_app's grants");
  for (const attr of ["superuser", "createdb", "createrole", "replication", "bypassrls"]) {
    assert.equal(service[attr] ?? false, false, `service role must not have ${attr}`);
  }
  assert.deepEqual(service.inRoles, [APP_GRANT_ROLE]);
  assert.deepEqual(service.passwordSecret, { name: "ranker-db-service" });

  // Both credentials live in OpenBao and are surfaced as basic-auth Secrets
  // whose username is the role's name.
  for (const [secret, role] of [["ranker-db-migrator", MIGRATOR], ["ranker-db-service", SERVICE]] as const) {
    const tmpl = externalSecretFor(secret).spec.target.template;
    assert.equal(tmpl?.type, "kubernetes.io/basic-auth", `${secret} must be a basic-auth Secret for CNPG`);
    assert.equal(tmpl.data.username, role, `${secret} username`);
    assert.match(tmpl.data.password, /\{\{.*\}\}/, `${secret} password comes from OpenBao`);
  }
  const serviceUri: string = externalSecretFor("ranker-db-service").spec.target.template.data.uri;
  assert.match(serviceUri, new RegExp(`^postgresql://${SERVICE}:\\{\\{.*\\}\\}@ranker-db-rw\\.corpus-ranker\\.svc(?:\\.cluster\\.local)?:5432/ranker\\b`));

  // --- The API connects as the service role, never as the owner.
  const api = findObject("Deployment", "ranker-api").spec.template.spec.containers.find((c: { name: string }) => c.name === "api");
  assert.deepEqual(secretRef(api, "RANKER_DATABASE_URL"), { name: "ranker-db-service", key: "uri" });
  const apiSecrets = JSON.stringify(findObject("Deployment", "ranker-api"));
  assert.doesNotMatch(apiSecrets, /ranker-db-migrator|ranker-db-app|ranker-db-superuser/, "the API must not see owner or superuser credentials");

  // --- The migration Job: an Argo CD PreSync hook, run as the migrator.
  const job = findObject("Job", "ranker-db-migrate");
  assert.equal(job.metadata.annotations?.["argocd.argoproj.io/hook"], "PreSync");
  assert.equal(job.metadata.annotations?.["argocd.argoproj.io/hook-delete-policy"], "BeforeHookCreation");
  const pod = job.spec.template.spec;
  assert.equal(pod.restartPolicy, "Never");

  // The merged migrations ship in the same image (and tag) as the API, so
  // the schema applied always matches the service being rolled out.
  const apiImage: string = api.image;
  assert.ok(apiImage.startsWith(`${API_IMAGE}:`) || apiImage.startsWith(`${API_IMAGE}@`), apiImage);
  const fetch = (pod.initContainers ?? []).find((c: { image: string }) => c.image === apiImage);
  assert.ok(fetch, `no init container copies the migrations out of ${apiImage}`);
  assert.match(fetch.command.concat(fetch.args ?? []).join(" "), /\/app\/db\/migrations/);
  const dockerfile = readFileSync(resolve(repoRoot, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^COPY db\/migrations \.\/db\/migrations$/m, "the image must carry db/migrations");

  assert.equal(pod.containers.length, 1);
  const migrate = pod.containers[0]!;
  assert.deepEqual(secretRef(migrate, "PGUSER"), { name: "ranker-db-migrator", key: "username" });
  assert.deepEqual(secretRef(migrate, "PGPASSWORD"), { name: "ranker-db-migrator", key: "password" });
  assert.match(env(migrate, "PGHOST").value ?? "", /^ranker-db-rw(\.|$)/, "migrations run against the primary");
  assert.equal(env(migrate, "PGDATABASE").value, "ranker");
  assert.doesNotMatch(JSON.stringify(job), /ranker-db-service|ranker-db-superuser/, "the Job holds only migrator credentials");

  // It runs deploy/db/migrate.sh, shipped as a ConfigMap, over the copied files.
  const command: string = migrate.command.concat(migrate.args ?? []).join(" ");
  assert.match(command, /migrate\.sh/);
  const scriptVolume = pod.volumes.find((v: { configMap?: { name: string } }) => v.configMap);
  assert.ok(scriptVolume, "the Job mounts no ConfigMap with the migrate script");
  const scriptCm = findObject("ConfigMap", scriptVolume.configMap.name);
  assert.equal(scriptCm.data["migrate.sh"], readFileSync(resolve(deployDir, "db", "migrate.sh"), "utf8"));

  // The API itself never runs migrations and never holds DDL rights.
  assert.equal(findObject("Deployment", "ranker-api").spec.template.spec.initContainers, undefined);
});

// Go's url.QueryEscape, which text/template's `urlquery` calls: unreserved
// bytes pass through, a space becomes "+", everything else is %XX-escaped.
function goQueryEscape(s: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(s)) {
    const ch = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-_.~]/.test(ch)) out += ch;
    else if (ch === " ") out += "+";
    else out += "%" + byte.toString(16).toUpperCase().padStart(2, "0");
  }
  return out;
}

/** Evaluates the ESO template's `{{ .password | ... }}` pipeline for the functions it may use. */
function renderPasswordPipeline(template: string, password: string): string {
  const m = /\{\{\s*\.password((?:\s*\|[^}]*)?)\}\}/.exec(template);
  assert.ok(m, `no .password pipeline in ${template}`);
  let value = password;
  for (const stage of m[1]!.split("|").map((s) => s.trim()).filter(Boolean)) {
    const replace = /^replace\s+"([^"]*)"\s+"([^"]*)"$/.exec(stage);
    if (stage === "urlquery") value = goQueryEscape(value);
    else if (replace) value = value.split(replace[1]!).join(replace[2]!);
    else assert.fail(`unhandled template function in password pipeline: ${stage}`);
  }
  return template.slice(0, m.index) + value + template.slice(m.index + m[0].length);
}

test("the service connection URI percent-encodes the password so libpq decodes it unchanged", () => {
  // libpq percent-decodes URI userinfo and does not treat "+" as a space, so
  // query encoding alone ("a b" -> "a+b") would hand Postgres the wrong password.
  const docs = parseYamlDocs(readFileSync(resolve(deployDir, "externalsecrets.yaml"), "utf8")) as K8sObject[];
  const es = docs.find((o) => o?.kind === "ExternalSecret" && o.metadata.name === "ranker-db-service");
  assert.ok(es, "no ranker-db-service ExternalSecret");
  const template: string = es.spec.target.template.data.uri;
  for (const password of ["a b", "a+b", "p@ss:w/rd?#%&=", "ünï cødé", "plain"]) {
    const uri = renderPasswordPipeline(template, password);
    const userinfo = /^postgresql:\/\/([^@/]*)@/.exec(uri)?.[1];
    assert.ok(userinfo, `rendered URI has no userinfo: ${uri}`);
    assert.doesNotMatch(userinfo, /[ +@/?#]/, `userinfo must be fully percent-encoded: ${userinfo}`);
    const [user, encoded] = userinfo.split(":");
    assert.equal(user, SERVICE);
    assert.equal(decodeURIComponent(encoded!), password, `password ${JSON.stringify(password)} round-trips`);
  }
});
