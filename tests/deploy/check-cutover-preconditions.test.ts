// CR-M3-ESTATE-PRECOND acceptance: deploy/estate/check-cutover-preconditions.ts
// reads back, with Kubernetes read requests only against the aks-obs-01
// kubeconfig it is given, the four estate preconditions the cutover readiness
// rule names for namespace corpus-ranker, in this order:
//
//   1. populated data store: Job ranker-juno-history-import is Complete;
//   2. workload image pulls: the image the corpus-ranker Application pins is
//      pullable (deploy/acr/check-image-pull.ts's comparison);
//   3. runtime secrets: every ExternalSecret in the namespace is Ready;
//   4. single writer: exactly one Argo CD Application, corpus-ranker, targets
//      the namespace;
//
// and exits non-zero naming the first that fails. The tests run the checker
// against a fake Kubernetes API (an HTTP server on 127.0.0.1) named by a
// kubeconfig whose cluster is aks-obs-01; nothing here reaches the estate.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deployDir } from "./render.ts";
import { listAll } from "../../deploy/estate/kube-pager.ts";

const checker = resolve(deployDir, "estate", "check-cutover-preconditions.ts");
const ACR = "noncelogicci.azurecr.io/corpus-ranker";
const SHA = "535bf267a9c1d0e4b2f3a4c5d6e7f8091a2b3c4d";
const PINNED = `${ACR}:sha-${SHA}`;
const GHCR = `ghcr.io/noncelogic/corpus-ranker:sha-${SHA}`;
const PG = "ghcr.io/cloudnative-pg/postgresql:17.7-standard-trixie";
const DIGEST = "sha256:d81e672d0000000000000000000000000000000000000000000000000000000f";
const NS = "corpus-ranker";

const JOB_PATH = `/apis/batch/v1/namespaces/${NS}/jobs/ranker-juno-history-import`;
const APP_PATH = "/apis/argoproj.io/v1alpha1/namespaces/argocd/applications/corpus-ranker";
const PODS_PATH = `/api/v1/namespaces/${NS}/pods`;
const ES_PATH = `/apis/external-secrets.io/v1/namespaces/${NS}/externalsecrets`;
const APPS_PATH = "/apis/argoproj.io/v1alpha1/applications";

let uid = 0;
const meta = (name: string, namespace: string) => ({ name, namespace, uid: `uid-${++uid}` });

function application(name: string, opts: { namespace?: string; dest?: string; images?: string[] } = {}) {
  return {
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Application",
    metadata: meta(name, opts.namespace ?? "argocd"),
    spec: {
      project: "default",
      destination: { server: "https://kubernetes.default.svc", namespace: opts.dest ?? NS },
      source: { repoURL: "https://github.com/noncelogic/corpus-ranker", targetRevision: "main", path: "deploy", kustomize: { images: opts.images ?? [PINNED] } },
    },
    status: { sync: { status: "Synced" }, health: { status: "Healthy" } },
  };
}

function job(conditions: Array<{ type: string; status: string; reason?: string }>) {
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: meta("ranker-juno-history-import", NS),
    status: { succeeded: conditions.some((c) => c.type === "Complete" && c.status === "True") ? 1 : 0, conditions },
  };
}
const COMPLETE = [{ type: "Complete", status: "True", reason: "Completed" }];

const containerId = (n: string) => `containerd://${n.padEnd(64, "a").replace(/[^0-9a-f]/g, "a").slice(0, 64)}`;
const running = (n: string, image: string) => ({
  name: n,
  image,
  imageID: `${image.split(/[:@]/)[0]}@${DIGEST}`,
  containerID: containerId(n),
  ready: true,
  state: { running: { startedAt: "2026-11-20T03:00:00Z" } },
  lastState: {},
});
const completed = (n: string, image: string) => ({
  ...running(n, image),
  state: { terminated: { exitCode: 0, reason: "Completed", containerID: containerId(n) } },
});
const pullFailed = (n: string, image: string) => ({
  name: n,
  image,
  imageID: "",
  ready: false,
  state: { waiting: { reason: "ImagePullBackOff", message: `Back-off pulling image "${image}"` } },
  lastState: {},
});

const apiPod = (image: string, status: object = running("api", image)) => ({
  apiVersion: "v1",
  kind: "Pod",
  metadata: meta("ranker-api-7c9d5b8f6d-x2k4q", NS),
  spec: { containers: [{ name: "api", image }] },
  status: { containerStatuses: [status] },
});
const migratePod = (image: string) => ({
  apiVersion: "v1",
  kind: "Pod",
  metadata: meta("ranker-db-migrate-8qz7m", NS),
  spec: { initContainers: [{ name: "migrations", image }], containers: [{ name: "migrate", image: PG }] },
  status: { initContainerStatuses: [completed("migrations", image)], containerStatuses: [running("migrate", PG)] },
});

function externalSecret(name: string, ready: "True" | "False" | undefined) {
  return {
    apiVersion: "external-secrets.io/v1",
    kind: "ExternalSecret",
    metadata: meta(name, NS),
    spec: { secretStoreRef: { kind: "ClusterSecretStore", name: "openbao" } },
    status: { conditions: ready === undefined ? [] : [{ type: "Ready", status: ready, reason: ready === "True" ? "SecretSynced" : "SecretSyncedError" }] },
  };
}

interface Estate {
  job?: unknown;
  app?: unknown;
  apiPods: unknown[];
  migratePods: unknown[];
  externalSecrets: unknown[];
  applications: unknown[];
  /** Page size the fake serves list reads with, to exercise the pager. */
  pageSize?: number;
}

function goodEstate(): Estate {
  const app = application("corpus-ranker");
  return {
    job: job(COMPLETE),
    app,
    apiPods: [apiPod(PINNED)],
    migratePods: [migratePod(PINNED)],
    externalSecrets: ["ranker-api-keys", "ranker-registry-pull", "ranker-minio"].map((n) => externalSecret(n, "True")),
    applications: [app, application("estate-observability", { dest: "observability" })],
  };
}

interface Request {
  method: string;
  path: string;
  query: URLSearchParams;
}

/** A fake Kubernetes API server that serves the estate's objects and records every request. */
async function fakeApi(t: TestContext, estate: Estate) {
  const requests: Request[] = [];
  const notFound = (res: import("node:http").ServerResponse, what: string) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ kind: "Status", apiVersion: "v1", status: "Failure", reason: "NotFound", code: 404, message: `${what} not found` }));
  };
  const list = (res: import("node:http").ServerResponse, items: unknown[], query: URLSearchParams) => {
    const size = estate.pageSize ?? items.length;
    const start = Number(query.get("continue") || 0);
    const page = items.slice(start, start + Math.max(size, 1));
    const next = start + page.length < items.length ? String(start + page.length) : undefined;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ kind: "List", apiVersion: "v1", metadata: { resourceVersion: "1", ...(next ? { continue: next } : {}) }, items: page }));
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    requests.push({ method: req.method ?? "", path: url.pathname, query: url.searchParams });
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end();
      return;
    }
    const sel = url.searchParams.get("labelSelector");
    switch (url.pathname) {
      case JOB_PATH:
        return estate.job ? (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify(estate.job))) : notFound(res, "job");
      case APP_PATH:
        return estate.app ? (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify(estate.app))) : notFound(res, "application");
      case PODS_PATH:
        if (sel === "app.kubernetes.io/name=ranker-api") return list(res, estate.apiPods, url.searchParams);
        if (sel === "app.kubernetes.io/name=ranker-db-migrate") return list(res, estate.migratePods, url.searchParams);
        break;
      case ES_PATH:
        return list(res, estate.externalSecrets, url.searchParams);
      case APPS_PATH:
        return list(res, estate.applications, url.searchParams);
    }
    notFound(res, url.pathname);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  t.after(() => new Promise<void>((ok) => server.close(() => ok())));
  const port = (server.address() as import("node:net").AddressInfo).port;
  const dir = mkdtempSync(join(tmpdir(), "fake-kubeconfig-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const kubeconfig = join(dir, "kubeconfig");
  writeFileSync(
    kubeconfig,
    `apiVersion: v1
kind: Config
clusters:
  - name: aks-obs-01
    cluster:
      server: http://127.0.0.1:${port}
contexts:
  - name: aks-obs-01
    context:
      cluster: aks-obs-01
      user: estate-reader
      namespace: default
current-context: aks-obs-01
users:
  - name: estate-reader
    user:
      token: fake-read-token
`,
  );
  return { kubeconfig, requests };
}

function runChecker(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string; output: string }> {
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, [checker, ...args], {
      cwd: tmpdir(),
      // No kubectl anywhere on PATH: the checker speaks to the API itself.
      env: { PATH: "/nonexistent", HOME: process.env.HOME ?? "/tmp" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", fail);
    child.on("close", (code) => ok({ code, stdout, stderr, output: `${stdout}${stderr}` }));
  });
}

test("passes when the import Job is Complete, the pinned image pulls, every ExternalSecret is Ready and one Application targets the namespace", async (t) => {
  const api = await fakeApi(t, goodEstate());
  const r = await runChecker(["--kubeconfig", api.kubeconfig]);
  assert.equal(r.code, 0, r.output);
  assert.equal(r.stderr, "");
  for (const re of [/populated data store/, /workload image pulls/, /runtime secrets/, /single writer/, new RegExp(PINNED), /ranker-registry-pull/]) {
    assert.match(r.stdout, re);
  }

  // Lists served one item per page are read whole through the pager.
  const paged = await fakeApi(t, { ...goodEstate(), pageSize: 1 });
  const p = await runChecker(["--kubeconfig", paged.kubeconfig]);
  assert.equal(p.code, 0, p.output);
  assert.ok(paged.requests.some((q) => q.path === ES_PATH && q.query.get("continue") === "2"), "the third ExternalSecret page was read");
});

test("refuses naming the failed precondition for each case (import Job absent or not Complete, image pull refused, an ExternalSecret not Ready, no Application or a second Application targeting the namespace)", async (t) => {
  const cases: Array<{ name: string; estate: (e: Estate) => Estate; precondition: string; expect: RegExp[] }> = [
    { name: "import Job absent", estate: (e) => ({ ...e, job: undefined }), precondition: "populated data store", expect: [/ranker-juno-history-import.*absent/] },
    {
      name: "import Job still running",
      estate: (e) => ({ ...e, job: job([]) }),
      precondition: "populated data store",
      expect: [/ranker-juno-history-import.*not Complete/],
    },
    {
      name: "import Job failed",
      estate: (e) => ({ ...e, job: job([{ type: "Failed", status: "True", reason: "BackoffLimitExceeded" }]) }),
      precondition: "populated data store",
      expect: [/ranker-juno-history-import.*not Complete.*Failed/],
    },
    {
      name: "image pull refused",
      estate: (e) => ({ ...e, apiPods: [apiPod(PINNED, pullFailed("api", PINNED))] }),
      precondition: "workload image pulls",
      expect: [/Rollout\/ranker-api: pod ranker-api-7c9d5b8f6d-x2k4q container api never ran: waiting \(ImagePullBackOff/],
    },
    {
      name: "Application pins the ghcr.io bridge image",
      estate: (e) => {
        const app = application("corpus-ranker", { images: [`${ACR}=${GHCR}`] });
        return { ...e, app, applications: [app] };
      },
      precondition: "workload image pulls",
      expect: [/image entry .*ghcr\.io/],
    },
    {
      name: "an ExternalSecret not Ready",
      estate: (e) => ({ ...e, externalSecrets: [externalSecret("ranker-api-keys", "True"), externalSecret("ranker-minio", "False")] }),
      precondition: "runtime secrets",
      expect: [/ExternalSecret corpus-ranker\/ranker-minio.*not Ready.*SecretSyncedError/],
    },
    {
      name: "an ExternalSecret with no Ready condition",
      estate: (e) => ({ ...e, externalSecrets: [externalSecret("ranker-api-keys", undefined)] }),
      precondition: "runtime secrets",
      expect: [/ExternalSecret corpus-ranker\/ranker-api-keys.*not Ready/],
    },
    { name: "no ExternalSecret at all", estate: (e) => ({ ...e, externalSecrets: [] }), precondition: "runtime secrets", expect: [/no ExternalSecret/] },
    {
      name: "no Application targets the namespace",
      estate: (e) => ({ ...e, applications: [application("estate-observability", { dest: "observability" })] }),
      precondition: "single writer",
      expect: [/no Argo CD Application targets namespace corpus-ranker/],
    },
    {
      name: "a second Application targets the namespace",
      estate: (e) => ({ ...e, applications: [...e.applications, application("ranker-legacy", { namespace: "juno" })] }),
      precondition: "single writer",
      expect: [/2 Argo CD Applications target namespace corpus-ranker/, /juno\/ranker-legacy/],
    },
    {
      name: "the one Application targeting the namespace is not corpus-ranker",
      estate: (e) => ({ ...e, applications: [application("ranker-legacy")] }),
      precondition: "single writer",
      expect: [/argocd\/ranker-legacy/, /not argocd\/corpus-ranker/],
    },
  ];
  for (const c of cases) {
    const api = await fakeApi(t, c.estate(goodEstate()));
    const r = await runChecker(["--kubeconfig", api.kubeconfig]);
    assert.equal(r.code, 1, `${c.name}: expected exit 1\n${r.output}`);
    assert.match(r.stderr, new RegExp(`precondition failed: ${c.precondition}`), `${c.name}: must name ${c.precondition}\n${r.stderr}`);
    for (const re of c.expect) assert.match(r.stderr, re, `${c.name}: stderr must name ${re}\n${r.stderr}`);
    // Only the first failing precondition is named.
    const others = ["populated data store", "workload image pulls", "runtime secrets", "single writer"].filter((p) => p !== c.precondition);
    for (const o of others) assert.doesNotMatch(r.stderr, new RegExp(`precondition failed: ${o}`), `${c.name}\n${r.stderr}`);
  }

  // The first failure wins when several fail.
  const api = await fakeApi(t, { ...goodEstate(), job: undefined, externalSecrets: [], applications: [] });
  const r = await runChecker(["--kubeconfig", api.kubeconfig]);
  assert.equal(r.code, 1, r.output);
  assert.match(r.stderr, /precondition failed: populated data store/);
  assert.doesNotMatch(r.stderr, /runtime secrets|single writer/);
});

test("issues only get and list requests against a fake Kubernetes API", async (t) => {
  for (const estate of [goodEstate(), { ...goodEstate(), pageSize: 1 }, { ...goodEstate(), applications: [] }]) {
    const api = await fakeApi(t, estate);
    await runChecker(["--kubeconfig", api.kubeconfig]);
    assert.ok(api.requests.length > 0);
    for (const q of api.requests) {
      assert.equal(q.method, "GET", `${q.method} ${q.path}`);
      assert.notEqual(q.query.get("watch"), "true", `watch on ${q.path}`);
      assert.ok([JOB_PATH, APP_PATH, PODS_PATH, ES_PATH, APPS_PATH].includes(q.path), `unexpected read ${q.path}`);
      assert.doesNotMatch(q.path, /\/secrets(\/|$)/, "never reads a Secret");
    }
  }
  // The happy path reads each object once and each list whole: one Job, one Application, two pod lists, the ExternalSecrets, the Applications.
  const api = await fakeApi(t, goodEstate());
  await runChecker(["--kubeconfig", api.kubeconfig]);
  assert.deepEqual(
    api.requests.map((q) => `${q.path}${q.query.get("labelSelector") ? `?${q.query.get("labelSelector")}` : ""}`).sort(),
    [JOB_PATH, APP_PATH, `${PODS_PATH}?app.kubernetes.io/name=ranker-api`, `${PODS_PATH}?app.kubernetes.io/name=ranker-db-migrate`, ES_PATH, APPS_PATH].sort(),
  );
});

test("refuses a kubeconfig that is not aks-obs-01 before any request, and a missing --kubeconfig", async (t) => {
  const api = await fakeApi(t, goodEstate());
  const dir = mkdtempSync(join(tmpdir(), "other-kubeconfig-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const other = join(dir, "kubeconfig");
  const { readFileSync } = await import("node:fs");
  writeFileSync(other, readFileSync(api.kubeconfig, "utf8").replaceAll("aks-obs-01", "aks-dev-02"));
  const r = await runChecker(["--kubeconfig", other]);
  assert.equal(r.code, 2, r.output);
  assert.match(r.stderr, /aks-obs-01/);
  assert.equal(api.requests.length, 0);

  const usage = await runChecker([]);
  assert.equal(usage.code, 2, usage.output);
  assert.match(usage.stderr, /usage/);
});

test("the list pager stops at its page cap and refuses a continue token that does not advance, a repeated item or an empty page with more", async () => {
  const item = (n: number) => ({ metadata: { uid: `u${n}`, name: `n${n}` } });
  const pages = (seq: Array<{ items: unknown[]; continue?: string }>) => async (cont: string | undefined) => seq[cont === undefined ? 0 : Number(cont)]!;

  assert.deepEqual(
    (await listAll("things", pages([{ items: [item(1)], continue: "1" }, { items: [item(2)] }]))).map((i: any) => i.metadata.uid),
    ["u1", "u2"],
  );
  await assert.rejects(listAll("things", async (c) => ({ items: [item(Number(c ?? 0))], continue: String(Number(c ?? 0) + 1) }), { maxPages: 3 }), /things: more than 3 pages/);
  await assert.rejects(listAll("things", pages([{ items: [item(1)], continue: "1" }, { items: [item(2)], continue: "1" }])), /things: continue token .* did not advance/);
  await assert.rejects(listAll("things", pages([{ items: [item(1)], continue: "1" }, { items: [item(1)] }])), /things: item u1 repeated/);
  await assert.rejects(listAll("things", pages([{ items: [], continue: "1" }, { items: [item(1)] }])), /things: empty page .* continue/);
});
