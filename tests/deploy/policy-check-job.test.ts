// CR-M3-POLICY-CHECK-JOB acceptance: deploy/history-import/policy-check-job.yaml
// is an opt-in Job, outside deploy/kustomization.yaml's Argo sync, that reads
// back the stored paper policy (cr_pol_paper v1) with the importer's
// read-only `--check-policy` mode, given only RANKER_DATABASE_URL.
//
// The manifest is read as written (it is applied by hand, never rendered by
// the overlay); its image is checked as the documented path renders it
// (`node deploy/opt-in-job.ts policy-check sha-<commit>`). The last test runs the Job's own command, as declared, with
// exactly the environment it declares (its secretKeyRef resolved to a fresh
// database) and checks it reports the policy and writes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { freshDatabase } from "../schema/fresh-db.ts";
import { deployDir, parseYamlDocs, renderObjects, repoRoot, type K8sObject } from "./render.ts";

const IMAGE = "noncelogicci.azurecr.io/corpus-ranker";
const JOB = "ranker-juno-policy-check";

function readJob(file: string): K8sObject {
  const docs = parseYamlDocs(readFileSync(resolve(deployDir, "history-import", file), "utf8")) as unknown as K8sObject[];
  assert.equal(docs.length, 1, `${file} declares exactly one object`);
  const job = docs[0]!;
  assert.equal(job.kind, "Job");
  return job;
}

const policyCheck = () => readJob("policy-check-job.yaml");

/** Render an opt-in Job through its documented path with the given tag. */
function renderJob(job: string, tag: string): K8sObject {
  const r = spawnSync(process.execPath, [resolve(deployDir, "opt-in-job.ts"), job, tag], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const jobs = (parseYamlDocs(r.stdout) as unknown as K8sObject[]).filter((o) => o.kind === "Job");
  assert.equal(jobs.length, 1);
  return jobs[0]!;
}
const historyImport = () => readJob("job.yaml");

test("the policy-check Job runs the importer's --check-policy mode with only the database URL, mounting no import volume and no object-store credentials", () => {
  const job = policyCheck();
  assert.equal(job.apiVersion, "batch/v1");
  assert.equal(job.metadata.name, JOB);
  const pod = job.spec.template.spec;
  assert.equal(pod.initContainers, undefined, "no verify init container: nothing is imported");
  assert.equal(pod.volumes, undefined, "no export volume");
  assert.deepEqual(pod.imagePullSecrets, [{ name: "ranker-registry-pull" }]);
  assert.equal(pod.containers.length, 1);
  const [c] = pod.containers;
  assert.equal(c.image, IMAGE, "the ranker image, tagged only when rendered (deploy/opt-in-job.ts)");
  assert.deepEqual([...c.command, ...(c.args ?? [])], ["node", "dist/import/juno-historical-import.js", "--check-policy"]);
  assert.equal(c.volumeMounts, undefined);
  assert.equal(c.envFrom, undefined);
  assert.deepEqual(c.env, [
    { name: "RANKER_DATABASE_URL", valueFrom: { secretKeyRef: { name: "ranker-db-service", key: "uri" } } },
  ]);
  assert.doesNotMatch(JSON.stringify(job), /RANKER_S3_|ranker-minio|RANKER_IMPORT_DIR|juno-papers-export/);
});

test("the policy-check Job's ranker image carries the same sha-<commit> tag as the history import Job", () => {
  const tag = "sha-535bf267131c58c223a3577c770fe4bb1a4b9528";
  const check = renderJob("policy-check", tag);
  const history = renderJob("history-import", tag);
  const images = (job: K8sObject): string[] =>
    [...(job.spec.template.spec.initContainers ?? []), ...job.spec.template.spec.containers].map((c: { image: string }) => c.image);
  assert.deepEqual(images(check), [`${IMAGE}:${tag}`]);
  assert.deepEqual([...new Set(images(history))], [`${IMAGE}:${tag}`]);
  assert.equal(check.spec.template.spec.containers[0].image, history.spec.template.spec.containers[0].image);
});

test("deploy/kustomization.yaml does not render the policy-check Job, so an Argo sync never runs it", () => {
  const rendered = renderObjects();
  assert.ok(rendered.length > 0);
  assert.equal(rendered.find((o) => o.metadata?.name === JOB), undefined);
  assert.equal(rendered.find((o) => o.metadata?.name === "ranker-juno-history-import"), undefined);
  const kustomization = readFileSync(resolve(deployDir, "kustomization.yaml"), "utf8");
  assert.doesNotMatch(kustomization, /history-import|policy-check/);
});

test("the policy-check Job keeps the history import Job's hardening (non-root, read-only root filesystem, all capabilities dropped, no service-account token, backoffLimit 0)", () => {
  const job = policyCheck();
  const reference = historyImport();
  assert.equal(job.spec.backoffLimit, 0);
  assert.ok(typeof job.spec.activeDeadlineSeconds === "number" && job.spec.activeDeadlineSeconds > 0);
  const pod = job.spec.template.spec;
  const refPod = reference.spec.template.spec;
  assert.equal(pod.restartPolicy, "Never");
  assert.equal(pod.automountServiceAccountToken, false);
  assert.deepEqual(pod.securityContext, refPod.securityContext);
  assert.equal(pod.securityContext.runAsNonRoot, true);
  const [c] = pod.containers;
  assert.deepEqual(c.securityContext, refPod.containers[0].securityContext);
  assert.deepEqual(c.securityContext, {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ["ALL"] },
  });
  assert.ok(c.resources?.limits?.memory, "a memory limit");
});

test("the policy-check Job's command, run with exactly its declared environment, reports the stored paper policy and writes nothing", async (t) => {
  const fixture = await freshDatabase(t);
  const [c] = policyCheck().spec.template.spec.containers;
  const argv: string[] = [...c.command, ...(c.args ?? [])];
  // The image ships src/ compiled to dist/ (tsconfig.build.json rootDir src, outDir dist).
  const entry = resolve(repoRoot, argv[1]!.replace(/^dist\//, "src/").replace(/\.js$/, ".ts"));
  const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
  for (const e of c.env as Array<{ name: string; value?: string; valueFrom?: any }>) {
    const ref = e.valueFrom?.secretKeyRef;
    assert.deepEqual(ref, { name: "ranker-db-service", key: "uri" }, `${e.name} comes from the database Secret`);
    env[e.name] = fixture.databaseUrl();
  }
  const snapshot = () => fixture.psql(
    "select count(*), coalesce(string_agg(md5(p::text), ',' order by id, version), '') from policies p",
  ) + "|" + fixture.psql("select count(*) from corpora") + "|" + fixture.psql("select count(*) from items");
  const before = snapshot();
  const run = spawnSync(process.execPath, [entry, ...argv.slice(2)], { env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim()), { policy_id: "cr_pol_paper", policy_version: 1, status: "absent" });
  assert.equal(snapshot(), before);
});
