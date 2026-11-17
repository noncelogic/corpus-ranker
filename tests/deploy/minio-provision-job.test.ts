// CR-D1-OBJSTORE-D2 acceptance: the MinIO provisioning Job
// (deploy/minio-provision-job.yaml) reaches OpenBao as its own service
// account, through its own Kubernetes auth role, whose policy grants read and
// patch on kv/corpus-ranker/minio and nothing else (CRANK-140; placement-defaults
// estate.credential_writeback). The role and the policy are recorded in
// devops/openbao/ and applied estate-side.
//
// The test loads both recorded files into a throwaway OpenBao dev server, then
// runs the Job's OpenBao steps (deploy/minio/provision.sh, in the Job's image
// and with its environment) with a token holding the role's policies alone, and
// checks every other operation is refused.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deployDir, findObject, renderObjects, repoRoot, type K8sObject } from "./render.ts";

const NAMESPACE = "corpus-ranker";
const JOB = "ranker-minio-provision";
const ROLE = "corpus-ranker-minio-provision";
const KV_MOUNT = "kv";
const KV_PATH = "corpus-ranker/minio";
const openbaoDir = resolve(repoRoot, "devops", "openbao");
const policyFile = resolve(openbaoDir, "policies", `${ROLE}.hcl`);
const roleFile = resolve(openbaoDir, "kubernetes-roles", `${ROLE}.json`);

interface Container {
  name: string;
  image: string;
  command: string[];
  env?: Array<{ name: string; value?: string; valueFrom?: unknown }>;
  volumeMounts?: Array<{ name: string; mountPath: string }>;
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
const stepOf = (c: Container): string => c.command[c.command.findIndex((a) => a.endsWith("/provision.sh")) + 1]!;
const containers = (job: K8sObject): Container[] =>
  [...(job.spec.template.spec.initContainers ?? []), ...job.spec.template.spec.containers] as Container[];
const usesOpenBao = (c: Container): boolean => (c.env ?? []).some((e) => e.name.startsWith("BAO_"));

const docker = (args: string[]): string => {
  try {
    return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    throw new Error(`docker ${args.join(" ")} failed: ${e.stdout ?? ""}${e.stderr ?? String(err)}`, { cause: err });
  }
};

/** Parse the recorded policy's `path "<p>" { capabilities = [...] }` stanzas; anything else in it fails the parse. */
function policyPaths(hcl: string): Map<string, string[]> {
  const body = hcl.replace(/#.*$/gm, "").trim();
  const stanza = /path\s+"([^"]+)"\s*\{\s*capabilities\s*=\s*\[([^\]]*)\]\s*\}/g;
  const paths = new Map<string, string[]>();
  let consumed = "";
  for (const m of body.matchAll(stanza)) {
    paths.set(m[1]!, m[2]!.split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean));
    consumed += m[0];
  }
  assert.equal(body.replace(/\s+/g, ""), consumed.replace(/\s+/g, ""), "the policy holds something other than path stanzas");
  return paths;
}

test("the provisioning Job runs as its dedicated service account and reads only kv/corpus-ranker/minio", { timeout: 600_000 }, async (t: TestContext) => {
  // --- The Job, its service account, and the role it names --------------------
  const job = findObject("Job", JOB);
  const sa = job.spec.template.spec.serviceAccountName as string;
  assert.equal(sa, JOB, "the Job runs as its own service account");
  assert.equal(findObject("ServiceAccount", sa).metadata.namespace, NAMESPACE);
  assert.notEqual(job.spec.template.spec.automountServiceAccountToken, false, "the Job logs in with its service account token");
  const others = renderObjects().filter((o) => o !== job && o.spec?.template?.spec?.serviceAccountName === sa);
  assert.deepEqual(others.map((o) => `${o.kind}/${o.metadata.name}`), [], "no other workload shares the Job's service account");

  const baoSteps = containers(job).filter(usesOpenBao);
  assert.deepEqual(baoSteps.map(stepOf), ["credentials", "publish"], "only the credentials and publish steps reach OpenBao");
  for (const c of baoSteps) {
    const env = valuesOf(c);
    assert.equal(env.BAO_K8S_AUTH_MOUNT, "kubernetes", `${c.name}: logs in through the estate's Kubernetes auth method`);
    assert.equal(env.BAO_K8S_AUTH_ROLE, ROLE, `${c.name}: logs in with the Job's own role`);
    assert.equal(`${env.BAO_KV_MOUNT}/${env.BAO_KV_PATH}`, `${KV_MOUNT}/${KV_PATH}`);
    assert.equal(env.BAO_TOKEN, undefined, `${c.name}: no static OpenBao token`);
    assert.ok(!(c.env ?? []).some((e) => e.name === "BAO_TOKEN"), `${c.name}: no OpenBao token from a Secret`);
  }

  // --- The recorded role binds that service account, in that namespace, alone --
  const role = JSON.parse(readFileSync(roleFile, "utf8")) as Role;
  assert.deepEqual(role.bound_service_account_names, [sa]);
  assert.deepEqual(role.bound_service_account_namespaces, [NAMESPACE]);
  assert.deepEqual(role.token_policies, [ROLE], "the role carries the provisioning policy only");
  const deadline = Number(job.spec.activeDeadlineSeconds);
  assert.ok(deadline > 0 && deadline <= 900, "the Job has a bounded deadline");
  assert.equal(role.token_ttl, `${deadline / 60}m`, "the token lives no longer than the Job may run");
  assert.equal(role.token_max_ttl, role.token_ttl);

  // --- The recorded policy: read and patch on the one data path ----------------
  const policy = readFileSync(policyFile, "utf8");
  assert.deepEqual([...policyPaths(policy)], [[`${KV_MOUNT}/data/${KV_PATH}`, ["read", "patch"]]]);

  // --- Live: load both into OpenBao and run the Job's steps with that policy ---
  const credentials = baoSteps.find((c) => stepOf(c) === "credentials")!;
  const publish = baoSteps.find((c) => stepOf(c) === "publish")!;
  const baoImage = publish.image;
  const id = `crbao-${randomBytes(4).toString("hex")}`;
  const vol = `${id}-work`;
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
  docker(["volume", "create", vol]);
  cleanup.push(["volume", "rm", "-f", vol]);
  const bao = `${id}-bao`;
  docker(["run", "-d", "--name", bao, "--network", id, "--entrypoint", "bao", baoImage,
    "server", "-dev", "-dev-root-token-id=root", "-dev-listen-address=0.0.0.0:8200"]);
  cleanup.push(["rm", "-f", bao]);

  /** The bao CLI inside the dev server as `token`; returns [exit code, output]. */
  const baoAs = (token: string, ...args: string[]): [number, string] => {
    try {
      const out = execFileSync("docker", ["exec", "-e", "BAO_ADDR=http://127.0.0.1:8200", "-e", `BAO_TOKEN=${token}`, bao, "bao", ...args],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      return [0, out];
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return [e.status ?? 1, `${e.stdout ?? ""}${e.stderr ?? ""}`];
    }
  };
  const asRoot = (...args: string[]): string => {
    const [code, out] = baoAs("root", ...args);
    assert.equal(code, 0, `bao ${args.join(" ")}: ${out}`);
    return out;
  };
  for (let i = 0; ; i++) {
    if (baoAs("root", "status")[0] === 0) break;
    if (i > 60) assert.fail("OpenBao dev server did not start");
    await new Promise((r) => setTimeout(r, 500));
  }

  asRoot("secrets", "enable", "-path=kv", "kv-v2");
  docker(["cp", policyFile, `${bao}:/tmp/policy.hcl`]);
  docker(["cp", roleFile, `${bao}:/tmp/role.json`]);
  asRoot("policy", "write", ROLE, "/tmp/policy.hcl");
  // The recorded role is a valid Kubernetes auth role as written.
  asRoot("auth", "enable", "kubernetes");
  asRoot("write", `auth/kubernetes/role/${ROLE}`, "@/tmp/role.json");
  const stored = JSON.parse(asRoot("read", "-format=json", `auth/kubernetes/role/${ROLE}`)).data;
  assert.deepEqual(stored.bound_service_account_names, [sa]);
  assert.deepEqual(stored.bound_service_account_namespaces, [NAMESPACE]);
  assert.deepEqual(stored.token_policies, [ROLE]);
  assert.equal(stored.token_ttl, deadline);

  // Estate-side state: the MinIO root credentials at the key, a neighbour's secret beside it.
  asRoot("kv", "put", "-mount=kv", KV_PATH, "root-user=ranker-root", "root-password=root-secret");
  asRoot("kv", "put", "-mount=kv", "corpus-ranker/api-keys", "joe=api-secret");

  // What a login through the role yields: the role's token policies (plus OpenBao's `default`).
  const token = JSON.parse(asRoot("token", "create", "-format=json", "-ttl=15m",
    ...role.token_policies.map((p) => `-policy=${p}`))).auth.client_token as string;

  docker(["run", "--rm", "--mount", `type=volume,src=${vol},dst=/w`, "--entrypoint", "chown", baoImage, "65532:65532", "/w"]);
  const run = (c: Container): void => {
    const env = { ...valuesOf(c), BAO_ADDR: `http://${bao}:8200`, BAO_TOKEN: token };
    const scripts = c.volumeMounts!.find((m) => m.name === "scripts")!.mountPath;
    const work = c.volumeMounts!.find((m) => m.name === "work")!.mountPath;
    const name = `${id}-${stepOf(c)}`;
    docker(["create", "--name", name, "--network", id, "--user", "65532:65532", "--mount", `type=volume,src=${vol},dst=${work}`,
      ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      "--entrypoint", c.command[0]!, c.image, ...c.command.slice(1)]);
    try {
      docker(["cp", resolve(deployDir, "minio") + "/.", `${name}:${scripts}`]);
      docker(["start", "-a", name]);
    } finally {
      docker(["rm", "-f", name]);
    }
  };

  // The Job's own steps succeed with the policy alone: read, then patch.
  run(credentials);
  run(publish);
  const field = (f: string): string => asRoot("kv", "get", "-mount=kv", `-field=${f}`, KV_PATH).trim();
  const password = field("service-password");
  assert.equal(field("service-user"), "ranker-service");
  assert.ok(password.length >= 32);
  assert.equal(field("root-password"), "root-secret", "the patch keeps the estate's root credentials");
  // A re-sync reads the published record back and keeps it.
  run(credentials);
  run(publish);
  assert.equal(field("service-password"), password);

  // ...and nothing else.
  const refused: string[][] = [
    ["kv", "get", "-mount=kv", "corpus-ranker/api-keys"],
    ["kv", "patch", "-mount=kv", "corpus-ranker/api-keys", "joe=x"],
    ["kv", "put", "-mount=kv", "corpus-ranker/other", "a=b"],
    ["kv", "put", "-mount=kv", KV_PATH, "service-user=x"],
    ["kv", "delete", "-mount=kv", KV_PATH],
    ["kv", "destroy", "-mount=kv", "-versions=1", KV_PATH],
    ["kv", "undelete", "-mount=kv", "-versions=1", KV_PATH],
    ["kv", "list", "-mount=kv", "corpus-ranker"],
    ["kv", "metadata", "get", "-mount=kv", KV_PATH],
    ["kv", "metadata", "put", "-mount=kv", "-max-versions=1", KV_PATH],
    ["kv", "metadata", "delete", "-mount=kv", KV_PATH],
    ["policy", "list"],
    ["read", `auth/kubernetes/role/${ROLE}`],
  ];
  for (const args of refused) {
    const [code, out] = baoAs(token, ...args);
    assert.notEqual(code, 0, `the Job's token must not: bao ${args.join(" ")}\n${out}`);
    assert.match(out, /permission denied|403/i, `bao ${args.join(" ")} failed for another reason: ${out}`);
  }
  assert.equal(field("service-password"), password, "the refused writes changed nothing");
  assert.equal(asRoot("kv", "get", "-mount=kv", "-field=joe", "corpus-ranker/api-keys").trim(), "api-secret");
});
