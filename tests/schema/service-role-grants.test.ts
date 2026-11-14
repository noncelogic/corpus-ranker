// CR-D1-DB acceptance (live half): the role split declared in deploy/
// holds on a real Postgres. A fresh instance is bootstrapped the way the
// CNPG Cluster in deploy/database.yaml bootstraps the estate one:
//   - initdb: database `ranker_estate` owned by the (non-superuser) migrator;
//   - postInitApplicationSQL + deploy/db/bootstrap.sql, as superuser;
//   - the managed service login role, a member of ranker_app;
// then deploy/db/migrate.sh (the PreSync Job's script) applies the merged
// migrations logged in as the migrator, and the service logs in for real.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { listMigrations } from "../../src/db/migrations.ts";
import { parseYamlDocs, repoRoot, type K8sObject } from "../deploy/render.ts";
import { freshDatabase, type Login } from "./fresh-db.ts";

const deployDir = resolve(repoRoot, "deploy");
const DB = "ranker_estate";

test("after migrations on a fresh Postgres the service role can insert score events but UPDATE and DELETE on score events are refused", { timeout: 600_000 }, async (t) => {
  const db = await freshDatabase(t, { migrate: false });

  // Roles and bootstrap SQL exactly as declared in the overlay.
  const cluster = (parseYamlDocs(readFileSync(resolve(deployDir, "database.yaml"), "utf8")) as K8sObject[])
    .find((o) => o.kind === "Cluster")!;
  const initdb = cluster.spec.bootstrap.initdb;
  const serviceRole = cluster.spec.managed.roles[0];
  const migrator: Login = { user: initdb.owner, password: "migrator-local", database: DB };
  const service: Login = { user: serviceRole.name, password: "service-local", database: DB };
  const superuser: Login = { user: "ranker", password: "ranker", database: DB };

  db.psql(`CREATE ROLE ${migrator.user} LOGIN PASSWORD '${migrator.password}';`);
  db.psql(`CREATE DATABASE ${DB} OWNER ${migrator.user};`);
  db.psqlLogin(superuser, (initdb.postInitApplicationSQL as string[]).join(";\n") + ";");
  db.psqlLogin(superuser, readFileSync(resolve(deployDir, "db", "bootstrap.sql"), "utf8"));
  db.psqlLogin(superuser, `CREATE ROLE ${service.user} LOGIN PASSWORD '${service.password}' IN ROLE ${(serviceRole.inRoles as string[]).join(", ")};`);

  // Apply the migrations with the Job's script, logged in as the migrator.
  for (const m of listMigrations()) db.writeFile(`/tmp/migrations/${m.file}`, m.sql);
  db.writeFile("/tmp/deploy/migrate.sh", readFileSync(resolve(deployDir, "db", "migrate.sh"), "utf8"));
  const migrate = () =>
    db.sh("sh /tmp/deploy/migrate.sh /tmp/migrations", {
      PGHOST: "127.0.0.1", PGPORT: "5432", PGUSER: migrator.user, PGPASSWORD: migrator.password, PGDATABASE: DB,
    });
  const first = migrate();
  for (const m of listMigrations()) assert.match(first, new RegExp(`applied ${m.file}`));
  assert.doesNotMatch(migrate(), /applied/, "a second run applies nothing");
  assert.equal(
    db.psqlLogin(migrator, "select string_agg(version::text, ',' order by version) from schema_migrations"),
    listMigrations().map((m) => m.version).join(","),
  );

  // The migrator alone owns the schema and everything in it, without being a superuser.
  assert.equal(db.psqlLogin(superuser, `select rolsuper from pg_roles where rolname = '${migrator.user}'`), "f");
  assert.equal(db.psqlLogin(superuser, "select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'public'"), migrator.user);
  assert.equal(
    db.psqlLogin(superuser, `
      select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and pg_get_userbyid(c.relowner) <> '${migrator.user}'`),
    "0",
  );
  assert.notEqual(db.psqlLogin(superuser, "select count(*) from pg_tables where schemaname = 'public'"), "0");

  // The service is an unprivileged writer that cannot change the schema.
  assert.equal(
    db.psqlLogin(superuser, `select rolsuper or rolcreaterole or rolcreatedb or rolbypassrls from pg_roles where rolname = '${service.user}'`),
    "f",
  );
  const denied = /permission denied|must be owner/;
  assert.throws(() => db.psqlLogin(service, "create table rogue (id int)"), denied);
  assert.throws(() => db.psqlLogin(service, "alter table score_events add column x int"), denied);
  assert.throws(() => db.psqlLogin(service, "drop table score_events"), denied);

  // It can append and read score events...
  db.psqlLogin(service, `
    insert into corpora (id, name, description, taxonomy_id, status)
      values ('cr_corpus_papers', 'papers', '', 'cr_tax_papers1', 'active');
    insert into items (id, corpus_id, item_type, title, canonical_fields, identity_keys, status)
      values ('cr_item_p1', 'cr_corpus_papers', 'paper', 'Paper One', '{}', '{}', 'active');
    insert into policies (id, version, name, corpus_id, dimensions, judge_config, composite_rule, created_by)
      values ('cr_pol_rubric', 1, 'paper-rubric', 'cr_corpus_papers', '[{"name":"Relevance"}]',
              '{"allowed_scorers":[],"source_blind":false}', '{"method":"weighted_sum","tie_breaks":[]}', 'joe');
    insert into score_events (id, item_id, policy_id, policy_version, dimension_scores, scorer, scored_at, source_blind)
      values ('cr_score_s1', 'cr_item_p1', 'cr_pol_rubric', 1,
              '[{"dimension":"Relevance","value":4,"reason":"why","evidence":[]}]',
              '{"identity":"joe"}', '2026-11-01T00:00:00Z', false);
  `);
  assert.equal(db.psqlLogin(service, "select count(*) from score_events"), "1");

  // ...but UPDATE and DELETE on them are refused.
  assert.throws(() => db.psqlLogin(service, "update score_events set policy_version = 1 where id = 'cr_score_s1'"), /permission denied/);
  assert.throws(() => db.psqlLogin(service, "delete from score_events where id = 'cr_score_s1'"), /permission denied/);
  assert.throws(() => db.psqlLogin(service, "truncate score_events"), /permission denied/);
  assert.equal(db.psqlLogin(migrator, "select count(*) from score_events"), "1");
});
