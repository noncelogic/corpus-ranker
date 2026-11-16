// CR-D1-OBJSTORE acceptance: the rendered overlay's provisioning Job creates
// the ranker bucket on the estate MinIO (TECH-STACK §5, §10, §11) with a
// policy granting write only to the ranker service user (CRANK-57,
// CR-D1-DEC-MINIO), publishes that user's credentials to OpenBao at
// kv/corpus-ranker/minio (TECH-STACK §9), and an ExternalSecret syncs them
// into the ranker namespace for the API.
//
// The first tests read the rendered overlay. The last one runs the Job's own
// script (deploy/minio/provision.sh, shipped as a ConfigMap) step by step, in
// the Job's own images and with the Job's environment, against a throwaway
// MinIO and an OpenBao dev server.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deployDir, findObject, renderObjects, type K8sObject } from "./render.ts";

const NAMESPACE = "corpus-ranker";
const BUCKET = "ranker-originals";
const SERVICE_USER = "ranker-service";
const JOB = "ranker-minio-provision";
const KV_MOUNT = "kv";
const KV_PATH = "corpus-ranker/minio";
const WAVE = "argocd.argoproj.io/sync-wave";
const HOOK = "argocd.argoproj.io/hook";

interface EnvVar {
  name: string;
  value?: string;
  valueFrom?: { secretKeyRef?: { name: string; key: string } };
}
interface Container {
  name: string;
  image: string;
  command?: string[];
  args?: string[];
  env?: EnvVar[];
  volumeMounts?: Array<{ name: string; mountPath: string }>;
}

const wave = (o: K8sObject): number => Number(o.metadata.annotations?.[WAVE]);
const valuesOf = (c: Container): Record<string, string> =>
  Object.fromEntries((c.env ?? []).filter((e) => e.value !== undefined).map((e) => [e.name, e.value!]));
const secretRefsOf = (c: Container): Record<string, { name: string; key: string }> =>
  Object.fromEntries((c.env ?? []).filter((e) => e.valueFrom?.secretKeyRef).map((e) => [e.name, e.valueFrom!.secretKeyRef!]));

function provisionJob(): K8sObject {
  return findObject("Job", JOB);
}
/** Every container of the Job in the order the pod runs them: init containers, then the main one. */
function steps(): Container[] {
  const pod = provisionJob().spec.template.spec;
  return [...(pod.initContainers ?? []), ...pod.containers] as Container[];
}
/** The provisioning script's step a container runs (`sh .../provision.sh <step>`). */
function stepOf(c: Container): string {
  const argv = [...(c.command ?? []), ...(c.args ?? [])];
  const i = argv.findIndex((a) => a.endsWith("/provision.sh"));
  assert.ok(i >= 0, `container ${c.name} does not run provision.sh: ${JSON.stringify(argv)}`);
  return argv[i + 1]!;
}
const script = (): string => readFileSync(resolve(deployDir, "minio", "provision.sh"), "utf8");
const writerPolicy = (): { Statement: Array<{ Effect: string; Action: string[]; Resource: string[] }> } =>
  JSON.parse(readFileSync(resolve(deployDir, "minio", "writer-policy.json"), "utf8"));

test("the rendered overlay's provisioning Job creates the ranker bucket on the estate MinIO, after MinIO is up", () => {
  const job = provisionJob();
  assert.equal(job.metadata.namespace, NAMESPACE);
  // A Sync hook, re-created on every sync (a Job's pod template is immutable).
  assert.equal(job.metadata.annotations?.[HOOK], "Sync");
  assert.equal(job.metadata.annotations?.["argocd.argoproj.io/hook-delete-policy"], "BeforeHookCreation");

  // One MinIO deployment on the estate (TECH-STACK §11), and the Job targets it.
  const minios = renderObjects().filter((o) => o.kind === "Deployment" && /minio/.test(o.metadata.name));
  assert.deepEqual(minios.map((o) => o.metadata.name), ["ranker-minio"], "exactly one MinIO deployment");
  const minio = minios[0]!;
  assert.ok(wave(job) > wave(minio), "the Job runs after the MinIO deployment is up");
  assert.ok(wave(job) > wave(findObject("Service", "ranker-minio")));

  const bucketStep = steps().find((c) => stepOf(c) === "bucket");
  assert.ok(bucketStep, "no container runs the bucket step");
  const env = valuesOf(bucketStep);
  assert.match(env.MINIO_ENDPOINT ?? "", /^http:\/\/ranker-minio(\.corpus-ranker(\.svc(\.cluster\.local)?)?)?:9000$/);
  assert.equal(env.RANKER_BUCKET, BUCKET);
  // The same mc that ships with the deployed MinIO.
  assert.equal(bucketStep.image, minio.spec.template.spec.containers[0].image);
  // The root credentials of that MinIO, and only in this step.
  assert.deepEqual(secretRefsOf(bucketStep), {
    MINIO_ROOT_USER: { name: "ranker-minio", key: "MINIO_ROOT_USER" },
    MINIO_ROOT_PASSWORD: { name: "ranker-minio", key: "MINIO_ROOT_PASSWORD" },
  });
  for (const c of steps().filter((s) => s !== bucketStep)) {
    assert.deepEqual(secretRefsOf(c), {}, `container ${c.name} must not hold the MinIO root credentials`);
  }

  // The Job is the bucket's creator; the deployment only serves it.
  assert.match(script(), /mc mb --ignore-existing "ranker\/\$RANKER_BUCKET"/);
  assert.doesNotMatch(JSON.stringify(minio), /mc mb/, "the MinIO deployment no longer creates the bucket itself");

  // The script and policy run verbatim from the rendered ConfigMap.
  const volume = job.spec.template.spec.volumes.find((v: { configMap?: { name: string } }) => v.configMap);
  const cm = findObject("ConfigMap", volume.configMap.name);
  assert.equal(cm.data["provision.sh"], script());
  assert.equal(cm.data["writer-policy.json"], readFileSync(resolve(deployDir, "minio", "writer-policy.json"), "utf8"));
});

test("the bucket's write policy covers only the ranker bucket and is attached only to the ranker service user", () => {
  const policy = writerPolicy();
  const writes = ["s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload"];
  for (const s of policy.Statement) {
    assert.equal(s.Effect, "Allow");
    for (const r of s.Resource) {
      assert.ok([`arn:aws:s3:::${BUCKET}`, `arn:aws:s3:::${BUCKET}/*`].includes(r), `policy reaches beyond ${BUCKET}: ${r}`);
    }
    assert.ok(!s.Action.some((a) => a === "*" || a === "s3:*" || a.startsWith("admin:")), `policy grants more than object access: ${s.Action}`);
  }
  const granted = policy.Statement.flatMap((s) => s.Action);
  for (const a of writes) assert.ok(granted.includes(a), `policy does not grant ${a}`);

  const bucketStep = steps().find((c) => stepOf(c) === "bucket")!;
  const env = valuesOf(bucketStep);
  assert.equal(env.RANKER_SERVICE_USER, SERVICE_USER);
  assert.equal(env.RANKER_WRITER_POLICY_FILE, `${bucketStep.volumeMounts!.find((m) => m.name === "scripts")!.mountPath}/writer-policy.json`);

  // Attached to the service user and nobody else; no anonymous access.
  const src = script();
  const attaches = [...src.matchAll(/mc admin policy attach .*$/gm)].map((m) => m[0]);
  assert.ok(attaches.length > 0, "the script never attaches the writer policy");
  for (const a of attaches) assert.match(a, /--user "\$RANKER_SERVICE_USER"/, a);
  assert.doesNotMatch(src, /--group|mc anonymous set (?!none)/);
  assert.match(src, /mc anonymous set none "ranker\/\$RANKER_BUCKET"/);
});

test("the Job publishes the service user's credentials to OpenBao at kv/corpus-ranker/minio, and an ExternalSecret syncs them for the API", () => {
  const job = provisionJob();
  const publish = steps().find((c) => stepOf(c) === "publish");
  assert.ok(publish, "no container runs the publish step");
  assert.ok(steps().indexOf(publish) > steps().findIndex((c) => stepOf(c) === "bucket"), "publish runs after the user exists");
  const env = valuesOf(publish);
  assert.equal(`${env.BAO_KV_MOUNT}/${env.BAO_KV_PATH}`, `${KV_MOUNT}/${KV_PATH}`);
  assert.match(script(), /bao kv patch -mount="\$BAO_KV_MOUNT" "\$BAO_KV_PATH" service-user=@[^ ]+ service-password=@/);
  // OpenBao auth is the Job's own Kubernetes service account.
  const sa = job.spec.template.spec.serviceAccountName;
  assert.ok(sa, "the Job runs under no dedicated service account");
  findObject("ServiceAccount", sa);
  assert.ok(env.BAO_K8S_AUTH_ROLE, "no OpenBao Kubernetes auth role set");

  // The ExternalSecret the API reads its S3 credentials from.
  const api = findObject("Deployment", "ranker-api");
  const refs = secretRefsOf(api.spec.template.spec.containers[0]);
  const keyId = refs.RANKER_S3_ACCESS_KEY_ID;
  const secret = refs.RANKER_S3_SECRET_ACCESS_KEY;
  assert.ok(keyId && secret, "the API reads no S3 credentials from a Secret");
  assert.equal(keyId.name, secret.name);
  assert.notEqual(keyId.name, "ranker-minio", "the API must not write with the MinIO root credentials");

  const es = renderObjects().find((o) => o.kind === "ExternalSecret" && (o.spec.target?.name ?? o.metadata.name) === keyId.name);
  assert.ok(es, `no ExternalSecret materialises ${keyId.name}`);
  assert.equal(es.metadata.namespace, NAMESPACE);
  assert.deepEqual(es.spec.secretStoreRef, { kind: "ClusterSecretStore", name: "openbao" });
  const byKey = new Map<string, { key: string; property: string }>(
    es.spec.data.map((d: { secretKey: string; remoteRef: { key: string; property: string } }) => [d.secretKey, d.remoteRef]),
  );
  // The `openbao` ClusterSecretStore reads the `kv` mount (as for every other key here).
  assert.deepEqual(byKey.get(keyId.key), { key: KV_PATH, property: "service-user" });
  assert.deepEqual(byKey.get(secret.key), { key: KV_PATH, property: "service-password" });

  // Order: the Job publishes, then the ExternalSecret syncs, then the API starts.
  assert.ok(wave(es) > wave(job), "the ExternalSecret syncs after the Job has published");
  assert.ok(wave(api) > wave(es), "the API starts after its credentials are synced");
});

// ---------------------------------------------------------------------------
// Live run of the Job's script against throwaway MinIO and OpenBao containers.

const docker = (args: string[], input?: string): string => {
  try {
    return execFileSync("docker", args, { encoding: "utf8", input, stdio: ["pipe", "pipe", "pipe"] });
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    throw new Error(`docker ${args.join(" ")} failed: ${e.stdout ?? ""}${e.stderr ?? String(err)}`, { cause: err });
  }
};

test("the provisioning script creates the bucket, a writer-only service user, and publishes the user to kv/corpus-ranker/minio, idempotently", { timeout: 600_000 }, async (t: TestContext) => {
  const id = `crobj-${randomBytes(4).toString("hex")}`;
  const net = id;
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
  docker(["network", "create", net]);
  cleanup.push(["network", "rm", net]);
  docker(["volume", "create", vol]);
  cleanup.push(["volume", "rm", "-f", vol]);

  const [credentials, bucket, publish] = ["credentials", "bucket", "publish"].map((s) => steps().find((c) => stepOf(c) === s)!);
  assert.ok(credentials && bucket && publish);
  assert.deepEqual(steps().map(stepOf), ["credentials", "bucket", "publish"]);
  const minioImage = bucket.image;
  const baoImage = publish.image;
  assert.equal(credentials.image, baoImage);

  const rootUser = "ranker-root";
  const rootPassword = `root-${randomBytes(12).toString("hex")}`;
  const minio = `${id}-minio`;
  docker(["run", "-d", "--name", minio, "--network", net, "-e", `MINIO_ROOT_USER=${rootUser}`, "-e", `MINIO_ROOT_PASSWORD=${rootPassword}`,
    "--entrypoint", "minio", minioImage, "server", "/data", "--address", ":9000"]);
  cleanup.push(["rm", "-f", minio]);
  const bao = `${id}-bao`;
  docker(["run", "-d", "--name", bao, "--network", net, "--entrypoint", "bao", baoImage,
    "server", "-dev", "-dev-root-token-id=root", "-dev-listen-address=0.0.0.0:8200"]);
  cleanup.push(["rm", "-f", bao]);
  const baoCli = (...args: string[]): string =>
    docker(["exec", "-e", "BAO_ADDR=http://127.0.0.1:8200", "-e", "BAO_TOKEN=root", bao, "bao", ...args]);
  for (let i = 0; ; i++) {
    try {
      baoCli("status");
      break;
    } catch (err) {
      if (i > 60) throw err;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  baoCli("secrets", "enable", "-path=kv", "kv-v2");
  // Estate-side state: the root credentials already sit at the key.
  baoCli("kv", "put", "-mount=kv", KV_PATH, `root-user=${rootUser}`, `root-password=${rootPassword}`);

  /** Run one step of the Job as its container would, pointed at the throwaway services. */
  const run = (c: Container, extra: Record<string, string> = {}): void => {
    const env: Record<string, string> = {
      ...valuesOf(c),
      ...(c === bucket ? { MINIO_ROOT_USER: rootUser, MINIO_ROOT_PASSWORD: rootPassword, MINIO_ENDPOINT: `http://${minio}:9000` } : {}),
      ...(c !== bucket ? { BAO_ADDR: `http://${bao}:8200`, BAO_TOKEN: "root" } : {}),
      ...extra,
    };
    const scripts = c.volumeMounts!.find((m) => m.name === "scripts")!.mountPath;
    const work = c.volumeMounts!.find((m) => m.name === "work")!.mountPath;
    const name = `${id}-${stepOf(c)}`;
    docker(["create", "--name", name, "--network", net, "--user", "65532:65532", "--mount", `type=volume,src=${vol},dst=${work}`,
      ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      "--entrypoint", c.command![0]!, c.image, ...c.command!.slice(1), ...(c.args ?? [])]);
    try {
      docker(["cp", resolve(deployDir, "minio") + "/.", `${name}:${scripts}`]);
      docker(["start", "-a", name]);
    } finally {
      docker(["rm", "-f", name]);
    }
  };
  // The emptyDir the Job shares between its containers, writable by the Job's user.
  docker(["run", "--rm", "--mount", `type=volume,src=${vol},dst=/w`, "--entrypoint", "chown", baoImage, "65532:65532", "/w"]);

  const provision = (): void => {
    for (const c of [credentials, bucket, publish]) run(c);
  };
  provision();

  const kvField = (field: string): string => baoCli("kv", "get", "-mount=kv", `-field=${field}`, KV_PATH).trim();
  const user = kvField("service-user");
  const password = kvField("service-password");
  assert.equal(user, SERVICE_USER);
  assert.ok(password.length >= 32, "a generated password of at least 32 characters");
  assert.equal(kvField("root-user"), rootUser, "publishing keeps the estate's root credentials");
  assert.equal(kvField("root-password"), rootPassword);

  /** mc as some identity against the throwaway MinIO; returns [exit code, output]. */
  const mc = (who: { user: string; password: string } | null, cmd: string): [number, string] => {
    // No credentials: mc's anonymous access.
    const alias = `mc alias set m http://${minio}:9000 "$U" "$P" >/dev/null && `;
    const out = docker(["run", "--rm", "--network", net, "-e", `U=${who?.user ?? ""}`, "-e", `P=${who?.password ?? ""}`,
      "-e", "MC_CONFIG_DIR=/tmp/mc", "--entrypoint", "sh", minioImage, "-c", `${alias}${cmd} 2>&1; echo "exit=$?"`]);
    const m = /exit=(\d+)\s*$/.exec(out);
    assert.ok(m, out);
    return [Number(m[1]), out];
  };
  const root = { user: rootUser, password: rootPassword };
  const service = { user, password };

  // The bucket exists and the service user can write, read and delete in it.
  const [lsCode, lsOut] = mc(root, "mc ls m");
  assert.equal(lsCode, 0, lsOut);
  assert.match(lsOut, new RegExp(`${BUCKET}/`));
  const put = (who: typeof service, key: string): [number, string] =>
    mc(who, `echo original | mc pipe m/${BUCKET}/${key}`);
  assert.equal(put(service, "sha256/aa")[0], 0, put(service, "sha256/aa")[1]);
  assert.equal(mc(service, `mc cat m/${BUCKET}/sha256/aa`)[0], 0);
  // ...and nothing else: not another bucket, not the admin API.
  assert.equal(mc(root, "mc mb m/other")[0], 0);
  assert.notEqual(mc(service, "echo x | mc pipe m/other/x")[0], 0, "the service user must not write outside the ranker bucket");
  assert.notEqual(mc(service, "mc admin user list m")[0], 0, "the service user must not administer MinIO");
  // Another MinIO user is not a writer, and neither is anyone anonymous.
  const other = { user: "someone-else", password: randomBytes(12).toString("hex") };
  assert.equal(mc(root, `mc admin user add m ${other.user} ${other.password}`)[0], 0);
  assert.notEqual(put(other, "sha256/bb")[0], 0, "a user without the writer policy must not write");
  assert.notEqual(mc(null, `echo x | mc pipe m/${BUCKET}/anon`)[0], 0, "anonymous writes must be refused");
  const [polCode, polOut] = mc(root, `mc admin policy entities m --policy ${valuesOf(bucket).RANKER_WRITER_POLICY}`);
  assert.equal(polCode, 0, polOut);
  assert.match(polOut, new RegExp(SERVICE_USER));
  assert.doesNotMatch(polOut, new RegExp(other.user));

  // A re-sync re-runs the Job: same user, same password, still a writer.
  provision();
  assert.equal(kvField("service-user"), user);
  assert.equal(kvField("service-password"), password);
  assert.equal(put(service, "sha256/cc")[0], 0);

  // Without OpenBao the Job fails rather than inventing credentials nobody holds.
  assert.throws(() => run(credentials, { BAO_ADDR: "http://127.0.0.1:1" }));
});
