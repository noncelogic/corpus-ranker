// CR-M3-D3 acceptance: on every Argo CD sync a Sync hook Job
// (deploy/api-keys-job.yaml), ordered before the ranker-api-keys
// ExternalSecret, logs in to OpenBao as its own service account through the
// Kubernetes auth role corpus-ranker-api-keys and writes one fresh key per
// authorised principal to kv/corpus-ranker/api-keys when that path is empty,
// leaving an existing key set untouched and never printing a key. The role and
// its policy are recorded in devops/openbao/ beside corpus-ranker-minio-provision.
//
// The authorised set follows CR-D1-DEC-PRINCIPALS and Rule:
// policies/placement-defaults.yaml#service_access: at the first deployment only
// the owner's principal, `joe`, gets a key; the agent principals get theirs in a
// later routine decision; Juno gets no new keys.
//
// The policy is the CR-M3-DEC-KEYGEN-GRANT default: create (a write the path
// does not yet hold) and read (to see that a key set is already there) on the
// one data path; no update, patch, delete, list, metadata, or other path
// (Rule: policies/placement-defaults.yaml#estate credential_writeback).
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deployDir, findObject, renderObjects, repoRoot, type K8sObject } from "./render.ts";
import { docker, policyPaths } from "./openbao-dev.ts";

const NAMESPACE = "corpus-ranker";
const JOB = "ranker-api-keys-generate";
const ROLE = "corpus-ranker-api-keys";
const KV_MOUNT = "kv";
const KV_PATH = "corpus-ranker/api-keys";
const AUTHORISED = ["joe"];
const KEY = /^[0-9a-f]{64}$/;
const WAVE = "argocd.argoproj.io/sync-wave";
const openbaoDir = resolve(repoRoot, "devops", "openbao");
const policyFile = resolve(openbaoDir, "policies", `${ROLE}.hcl`);
const roleFile = resolve(openbaoDir, "kubernetes-roles", `${ROLE}.json`);
const scriptFile = resolve(deployDir, "api-keys", "generate.sh");

interface Container {
  name: string;
  image: string;
  command: string[];
  env?: Array<{ name: string; value?: string; valueFrom?: unknown }>;
  volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
}
interface Role {
  bound_service_account_names: string[];
  bound_service_account_namespaces: string[];
  token_policies: string[];
  token_ttl: string;
  token_max_ttl: string;
}

const valuesOf = (c: Container): Record<string, string> =>
  Object.fromEntries((c.env ?? []).filter((e) => e.value !== undefined).map((e) => [e.name, e.value!]));
const containersOf = (job: K8sObject): Container[] =>
  [...(job.spec.template.spec.initContainers ?? []), ...job.spec.template.spec.containers] as Container[];
const wave = (o: K8sObject): number => Number(o.metadata.annotations?.[WAVE]);

test("the API key Job is a Sync hook ordered before the ranker-api-keys ExternalSecret, runs as its own service account, and logs in with the corpus-ranker-api-keys role", () => {
  const job = findObject("Job", JOB);
  assert.equal(job.metadata.namespace, NAMESPACE);
  const annotations = job.metadata.annotations ?? {};
  assert.equal(annotations["argocd.argoproj.io/hook"], "Sync", "the Job runs on every sync, as a Sync hook");
  assert.equal(annotations["argocd.argoproj.io/hook-delete-policy"], "BeforeHookCreation", "re-created on every sync");
  const es = findObject("ExternalSecret", "ranker-api-keys");
  assert.equal(es.metadata.annotations?.["argocd.argoproj.io/hook"], undefined, "the ExternalSecret is a regular resource");
  assert.ok(wave(job) < wave(es), `the Job (wave ${wave(job)}) runs before the ranker-api-keys ExternalSecret (wave ${wave(es)})`);
  assert.ok(wave(es) < wave(findObject("Deployment", "ranker-api")), "the API starts after its keys are synced");

  // Its own service account, shared with no other workload.
  const spec = job.spec.template.spec;
  const sa = spec.serviceAccountName as string;
  assert.equal(sa, JOB, "the Job runs as its own service account");
  const account = findObject("ServiceAccount", sa);
  assert.equal(account.metadata.namespace, NAMESPACE);
  assert.ok(wave(account) < wave(job), "the service account exists before the Job");
  assert.notEqual(spec.automountServiceAccountToken, false, "the Job logs in with its service account token");
  const others = renderObjects().filter((o) => o !== job && o.spec?.template?.spec?.serviceAccountName === sa);
  assert.deepEqual(others.map((o) => `${o.kind}/${o.metadata.name}`), [], "no other workload shares the Job's service account");

  // One container, the generator, logging in through the role; no static token.
  const containers = containersOf(job);
  assert.equal(containers.length, 1);
  const c = containers[0]!;
  assert.deepEqual(c.command, ["sh", "/scripts/generate.sh"]);
  const env = valuesOf(c);
  assert.equal(env.BAO_K8S_AUTH_MOUNT, "kubernetes", "logs in through the estate's Kubernetes auth method");
  assert.equal(env.BAO_K8S_AUTH_ROLE, ROLE, "logs in with the Job's own role");
  assert.equal(`${env.BAO_KV_MOUNT}/${env.BAO_KV_PATH}`, `${KV_MOUNT}/${KV_PATH}`);
  assert.ok(!(c.env ?? []).some((e) => e.name === "BAO_TOKEN"), "no static OpenBao token");
  assert.ok(!(c.env ?? []).some((e) => e.valueFrom !== undefined), "the Job reads no Secret");
  assert.match(c.image, /\/openbao\/openbao:[^@]+@sha256:[0-9a-f]{64}$/, "a pinned OpenBao image");
  const script = readFileSync(scriptFile, "utf8");
  assert.match(script, /auth\/\$\{?BAO_K8S_AUTH_MOUNT[^/]*\/login/, "the script logs in through the Kubernetes auth mount");
  assert.match(script, /role="\$BAO_K8S_AUTH_ROLE"/);
  assert.match(script, /jwt=@\/var\/run\/secrets\/kubernetes\.io\/serviceaccount\/token/, "with the pod's service account token");

  // The script reaches the pod through its own ConfigMap, synced before the Job.
  const volume = (spec.volumes as Array<{ name: string; configMap?: { name: string } }>).find((v) => v.name === "scripts");
  const cm = findObject("ConfigMap", volume!.configMap!.name);
  assert.equal(cm.data["generate.sh"], script, "the ConfigMap ships deploy/api-keys/generate.sh as written");
  assert.ok(wave(cm) < wave(job));

  const deadline = Number(job.spec.activeDeadlineSeconds);
  assert.ok(deadline > 0 && deadline <= 900, "the Job has a bounded deadline");

  // The recorded role binds that service account, in that namespace, alone.
  const role = JSON.parse(readFileSync(roleFile, "utf8")) as Role;
  assert.deepEqual(role.bound_service_account_names, [sa]);
  assert.deepEqual(role.bound_service_account_namespaces, [NAMESPACE]);
  assert.deepEqual(role.token_policies, [ROLE], "the role carries the key generation policy only");
  assert.equal(role.token_ttl, `${deadline / 60}m`, "the token lives no longer than the Job may run");
  assert.equal(role.token_max_ttl, role.token_ttl);

  // Recorded beside the MinIO provisioning grant, with the apply commands.
  const readme = readFileSync(resolve(openbaoDir, "README.md"), "utf8");
  assert.ok(readme.includes(`bao policy write ${ROLE} devops/openbao/policies/${ROLE}.hcl`));
  assert.ok(readme.includes(`bao write auth/kubernetes/role/${ROLE} @devops/openbao/kubernetes-roles/${ROLE}.json`));

  // No hand step is left to run.
  assert.throws(() => readFileSync(resolve(deployDir, "openbao", "generate-api-keys.sh")), /ENOENT/, "the hand-run generator is retired");

  // POSIX sh, never traced (tracing would print the keys).
  assert.match(script, /^#!\/bin\/sh\n/);
  assert.doesNotMatch(script, /set -[a-z]*x|set -o xtrace/);
  execFileSync("sh", ["-n", scriptFile]);
});

/** A dev OpenBao with the recorded policy and role loaded, and a token holding the role's policies alone. */
async function loadedOpenBao(t: TestContext) {
  const job = findObject("Job", JOB);
  const c = containersOf(job)[0]!;
  const id = `crbao-${randomBytes(4).toString("hex")}`;
  const cleanup: string[][] = [];
  t.after(() => {
    for (const args of cleanup.reverse()) {
      try {
        docker(args);
      } catch {
        // best effort
      }
    }
  });
  docker(["network", "create", id]);
  cleanup.push(["network", "rm", id]);
  const bao = `${id}-bao`;
  docker(["run", "-d", "--name", bao, "--network", id, "--entrypoint", "bao", c.image,
    "server", "-dev", "-dev-root-token-id=root", "-dev-listen-address=0.0.0.0:8200"]);
  cleanup.push(["rm", "-f", bao]);

  const as = (token: string, ...args: string[]): [number, string] => {
    try {
      const out = execFileSync("docker", ["exec", "-e", "BAO_ADDR=http://127.0.0.1:8200", "-e", `BAO_TOKEN=${token}`, bao, "bao", ...args],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return [0, out];
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return [e.status ?? 1, `${e.stdout ?? ""}${e.stderr ?? ""}`];
    }
  };
  const root = (...args: string[]): string => {
    const [code, out] = as("root", ...args);
    assert.equal(code, 0, `bao ${args.join(" ")}: ${out}`);
    return out;
  };
  for (let i = 0; ; i++) {
    if (as("root", "status")[0] === 0) break;
    if (i > 60) assert.fail("OpenBao dev server did not start");
    await new Promise((r) => setTimeout(r, 500));
  }
  root("secrets", "enable", "-path=kv", "kv-v2");
  docker(["cp", policyFile, `${bao}:/tmp/policy.hcl`]);
  docker(["cp", roleFile, `${bao}:/tmp/role.json`]);
  root("policy", "write", ROLE, "/tmp/policy.hcl");
  // The recorded role is a valid Kubernetes auth role as written.
  root("auth", "enable", "kubernetes");
  root("write", `auth/kubernetes/role/${ROLE}`, "@/tmp/role.json");
  const role = JSON.parse(readFileSync(roleFile, "utf8")) as Role;
  const stored = JSON.parse(root("read", "-format=json", `auth/kubernetes/role/${ROLE}`)).data;
  assert.deepEqual(stored.token_policies, [ROLE]);
  // What a login through the role yields: the role's token policies (plus OpenBao's `default`).
  const token = JSON.parse(root("token", "create", "-format=json", `-ttl=${role.token_ttl}`,
    ...role.token_policies.map((p) => `-policy=${p}`))).auth.client_token as string;

  // The ConfigMap's files, as a read-only volume like the Job's.
  const scriptsVol = `${id}-scripts`;
  docker(["volume", "create", scriptsVol]);
  cleanup.push(["volume", "rm", "-f", scriptsVol]);
  const filler = `${id}-fill`;
  docker(["create", "--name", filler, "--mount", `type=volume,src=${scriptsVol},dst=/scripts`, c.image]);
  try {
    docker(["cp", resolve(deployDir, "api-keys") + "/.", `${filler}:/scripts`]);
  } finally {
    docker(["rm", "-f", filler]);
  }

  /** Run the Job's container as written (image, command, env, user, read-only root), with `token` for the login. */
  const runJob = (): { code: number; output: string } => {
    const env = { ...valuesOf(c), BAO_ADDR: `http://${bao}:8200`, BAO_TOKEN: token };
    const scripts = c.volumeMounts!.find((m) => m.name === "scripts")!.mountPath;
    const name = `${id}-job-${randomBytes(2).toString("hex")}`;
    const sc = job.spec.template.spec.securityContext;
    docker(["create", "--name", name, "--network", id, "--user", `${sc.runAsUser}:${sc.runAsGroup}`, "--read-only", "--tmpfs", "/tmp",
      "--mount", `type=volume,src=${scriptsVol},dst=${scripts},readonly`,
      ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      "--entrypoint", c.command[0]!, c.image, ...c.command.slice(1)]);
    try {
      try {
        const output = execFileSync("docker", ["start", "-a", name], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
        return { code: 0, output };
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { code: e.status ?? 1, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
      }
    } finally {
      docker(["rm", "-f", name]);
    }
  };
  return { as, root, token, runJob };
}

test("run against OpenBao with the corpus-ranker-api-keys policy alone, the Job writes one key per authorised principal to an empty kv/corpus-ranker/api-keys, prints no key, and on a second sync succeeds with the key set unchanged", { timeout: 600_000 }, async (t) => {
  const { root, runJob } = await loadedOpenBao(t);
  // A neighbour's secret under the product path, which the Job must leave alone.
  root("kv", "put", "-mount=kv", "corpus-ranker/minio", "root-user=ranker-root");

  const first = runJob();
  assert.equal(first.code, 0, first.output);
  const read = () => JSON.parse(root("kv", "get", "-format=json", "-mount=kv", KV_PATH)).data as { data: Record<string, string>; metadata: { version: number } };
  const stored = read();
  const keys = stored.data;
  assert.deepEqual(Object.keys(keys).sort(), AUTHORISED, "kv/corpus-ranker/api-keys holds exactly the authorised principals");
  for (const [principal, key] of Object.entries(keys)) {
    assert.match(key, KEY, `${principal}'s key is 256 random bits, hex`);
    assert.ok(!first.output.includes(key), "the Job printed an API key");
  }
  assert.equal(stored.metadata.version, 1);
  assert.deepEqual(JSON.parse(root("kv", "list", "-format=json", "-mount=kv", "corpus-ranker")).sort(), ["api-keys", "minio"], "nothing else written");

  // A second sync succeeds and leaves the key set as it was.
  const second = runJob();
  assert.equal(second.code, 0, second.output);
  assert.match(second.output, /kept/i);
  const after = read();
  assert.deepEqual(after.data, keys);
  assert.equal(after.metadata.version, 1, "a re-sync writes no new version");
  for (const key of Object.values(keys)) assert.ok(!second.output.includes(key), "a re-sync printed an API key");

  // A key set someone else wrote (say, an earlier hand run) is kept as is too.
  root("kv", "metadata", "delete", "-mount=kv", KV_PATH);
  root("kv", "put", "-mount=kv", KV_PATH, "joe=existing-key");
  const kept = runJob();
  assert.equal(kept.code, 0, kept.output);
  assert.ok(!kept.output.includes("existing-key"), "the Job printed an API key");
  assert.equal(root("kv", "get", "-mount=kv", "-field=joe", KV_PATH).trim(), "existing-key");

  // A key set missing an authorised principal is not silently patched; the sync fails loudly.
  root("kv", "metadata", "delete", "-mount=kv", KV_PATH);
  root("kv", "put", "-mount=kv", KV_PATH, "someone=other-key");
  const partial = runJob();
  assert.notEqual(partial.code, 0, "a key set lacking an authorised principal fails the sync");
  assert.ok(!partial.output.includes("other-key"));
  assert.deepEqual(JSON.parse(root("kv", "get", "-format=json", "-mount=kv", KV_PATH)).data.data, { someone: "other-key" });
});

test("the corpus-ranker-api-keys policy can neither update, delete, list nor read metadata on kv/corpus-ranker/api-keys, nor touch any other path", { timeout: 600_000 }, async (t) => {
  // As recorded: create and read on the one data path, nothing else.
  assert.deepEqual([...policyPaths(readFileSync(policyFile, "utf8"))], [[`${KV_MOUNT}/data/${KV_PATH}`, ["create", "read"]]]);

  const { as, root, token } = await loadedOpenBao(t);
  root("kv", "put", "-mount=kv", "corpus-ranker/minio", "root-user=ranker-root");
  root("kv", "put", "-mount=kv", "other-product/api-keys", "x=y");

  // Allowed: create on the empty path, then read it back.
  const [created, out] = as(token, "kv", "put", "-mount=kv", "-cas=0", KV_PATH, "joe=k1");
  assert.equal(created, 0, out);
  assert.equal(as(token, "kv", "get", "-mount=kv", "-field=joe", KV_PATH)[0], 0);

  const refused: string[][] = [
    ["kv", "put", "-mount=kv", KV_PATH, "joe=k2"],
    ["kv", "put", "-mount=kv", "-cas=1", KV_PATH, "joe=k2"],
    ["kv", "patch", "-mount=kv", KV_PATH, "joe=k2"],
    ["kv", "delete", "-mount=kv", KV_PATH],
    ["kv", "destroy", "-mount=kv", "-versions=1", KV_PATH],
    ["kv", "undelete", "-mount=kv", "-versions=1", KV_PATH],
    ["kv", "list", "-mount=kv", "corpus-ranker"],
    ["kv", "metadata", "get", "-mount=kv", KV_PATH],
    ["kv", "metadata", "put", "-mount=kv", "-max-versions=1", KV_PATH],
    ["kv", "metadata", "delete", "-mount=kv", KV_PATH],
    ["kv", "get", "-mount=kv", "corpus-ranker/minio"],
    ["kv", "put", "-mount=kv", "corpus-ranker/minio", "a=b"],
    ["kv", "put", "-mount=kv", "corpus-ranker/api-keys-old", "a=b"],
    ["kv", "put", "-mount=kv", "corpus-ranker/api-keys/x", "a=b"],
    ["kv", "get", "-mount=kv", "other-product/api-keys"],
    ["policy", "list"],
    ["read", `auth/kubernetes/role/${ROLE}`],
  ];
  for (const args of refused) {
    const [code, o] = as(token, ...args);
    assert.notEqual(code, 0, `the Job's token must not: bao ${args.join(" ")}\n${o}`);
    assert.match(o, /permission denied|403/i, `bao ${args.join(" ")} failed for another reason: ${o}`);
  }
  const stored = JSON.parse(root("kv", "get", "-format=json", "-mount=kv", KV_PATH)).data;
  assert.deepEqual(stored.data, { joe: "k1" }, "the refused writes changed nothing");
  assert.equal(stored.metadata.version, 1);
  assert.equal(root("kv", "get", "-mount=kv", "-field=root-user", "corpus-ranker/minio").trim(), "ranker-root");
});
