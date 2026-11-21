#!/usr/bin/env node
// Read back the estate preconditions the ranker's cutover blocks name
// (CR-M3-ESTATE-PRECOND; depended on by CR-M3-D3c, CR-M3-D3d and CR-M3-D1):
//
//   node deploy/estate/check-cutover-preconditions.ts --kubeconfig <path> [--context <name>]
//
// It reads, through the Kubernetes API of the cluster the given kubeconfig
// names (its current context, or --context), the four preconditions the
// cutover readiness rule names for namespace corpus-ranker, in this order, and
// stops at the first that fails:
//
//   1. populated data store: Job corpus-ranker/ranker-juno-history-import has
//      condition Complete=True (the Juno history import ran to the end);
//   2. workload image pulls: the image the corpus-ranker Application
//      (namespace argocd) pins is pullable -- the comparison of
//      deploy/acr/check-image-pull.ts (checkImagePull) on the Application and
//      the pods of the API Rollout and the migration Job, read here through
//      the API instead of kubectl;
//   3. runtime secrets: there is at least one ExternalSecret in the namespace
//      and every one has condition Ready=True;
//   4. single writer: exactly one Argo CD Application in the cluster has
//      spec.destination.namespace corpus-ranker, and it is argocd/corpus-ranker.
//
// Read-only: every request is an HTTP GET (a get of one object or a list,
// never a watch), and no Secret is read. List reads go through the bounded
// pager in kube-pager.ts. The kubeconfig must be the aks-obs-01 one: the
// selected context or its cluster is named aks-obs-01, otherwise nothing is
// read (Rule: policies/placement-defaults.yaml#estate, system-of-record
// services run on aks-obs-01; #credentials, it uses the existing read
// kubeconfig, no new credential). Supported kubeconfig credentials: token,
// tokenFile, client certificate and key (data or file), and an exec plugin
// that returns an ExecCredential (kubelogin).
//
// Exit 0: all four hold; each is printed on stdout. Exit 1: the first failing
// precondition is named on stderr ("precondition failed: <name>") after one
// line per finding. Exit 2: a read failed for another reason (unreachable,
// forbidden, a list beyond the page cap), the kubeconfig is not aks-obs-01 or
// unreadable, or a usage error.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { APP, checkImagePull, ReadError as ImageReadError, WORKLOADS } from "../acr/check-image-pull.ts";
import { parseYamlDocs } from "../yaml.ts";
import { listAll, PagerError } from "./kube-pager.ts";

export const CLUSTER = "aks-obs-01";
const NAMESPACE = "corpus-ranker";
const IMPORT_JOB = "ranker-juno-history-import";
const PAGE_LIMIT = 250;

class ReadError extends Error {}

const isRecord = (v: unknown): v is Record<string, any> => typeof v === "object" && v !== null && !Array.isArray(v);
const quote = (v: unknown) => JSON.stringify(v);

// ---------------------------------------------------------------------------
// Kubeconfig and a read-only API client.

interface Connection {
  server: URL;
  tls: Pick<RequestOptions, "ca" | "cert" | "key" | "rejectUnauthorized">;
  token?: string;
}

const named = (list: unknown, name: string, key: string): Record<string, any> | undefined => {
  const entry = (Array.isArray(list) ? list : []).find((e) => isRecord(e) && e.name === name);
  return isRecord(entry) && isRecord(entry[key]) ? entry[key] : undefined;
};

function readKubeconfig(path: string, contextName: string | undefined): Connection {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ReadError(`cannot read kubeconfig ${path}: ${(err as Error).message}`);
  }
  let config: unknown;
  try {
    config = text.trimStart().startsWith("{") ? JSON.parse(text) : parseYamlDocs(text)[0];
  } catch (err) {
    throw new ReadError(`kubeconfig ${path} does not parse: ${(err as Error).message}`);
  }
  if (!isRecord(config)) throw new ReadError(`kubeconfig ${path} is not a Config`);
  const ctxName = contextName ?? config["current-context"];
  if (typeof ctxName !== "string" || ctxName === "") throw new ReadError(`kubeconfig ${path} has no current-context; pass --context`);
  const ctx = named(config.contexts, ctxName, "context");
  if (!ctx) throw new ReadError(`kubeconfig ${path} has no context ${quote(ctxName)}`);
  const clusterName = String(ctx.cluster ?? "");
  if (ctxName !== CLUSTER && clusterName !== CLUSTER) {
    throw new ReadError(`kubeconfig ${path}: context ${quote(ctxName)} (cluster ${quote(clusterName)}) is not ${CLUSTER}; refusing to read`);
  }
  const cluster = named(config.clusters, clusterName, "cluster");
  if (!cluster || typeof cluster.server !== "string") throw new ReadError(`kubeconfig ${path}: cluster ${quote(clusterName)} has no server`);
  const user = named(config.users, String(ctx.user ?? ""), "user") ?? {};
  const base = dirname(resolve(path));
  const file = (p: unknown) => readFileSync(resolve(base, String(p)));
  const b64 = (s: unknown) => Buffer.from(String(s), "base64");

  const conn: Connection = { server: new URL(cluster.server), tls: {} };
  if (cluster["certificate-authority-data"]) conn.tls.ca = b64(cluster["certificate-authority-data"]);
  else if (cluster["certificate-authority"]) conn.tls.ca = file(cluster["certificate-authority"]);
  if (cluster["insecure-skip-tls-verify"] === true) conn.tls.rejectUnauthorized = false;
  if (user["client-certificate-data"]) conn.tls.cert = b64(user["client-certificate-data"]);
  else if (user["client-certificate"]) conn.tls.cert = file(user["client-certificate"]);
  if (user["client-key-data"]) conn.tls.key = b64(user["client-key-data"]);
  else if (user["client-key"]) conn.tls.key = file(user["client-key"]);
  if (typeof user.token === "string") conn.token = user.token;
  else if (user.tokenFile) conn.token = file(user.tokenFile).toString("utf8").trim();
  else if (isRecord(user.exec)) execCredential(user.exec, conn);
  return conn;
}

/** Run a kubeconfig exec plugin (client.authentication.k8s.io ExecCredential) and take its token or client certificate. */
function execCredential(exec: Record<string, any>, conn: Connection): void {
  const env = { ...process.env };
  for (const e of Array.isArray(exec.env) ? exec.env : []) if (isRecord(e)) env[String(e.name)] = String(e.value ?? "");
  env.KUBERNETES_EXEC_INFO = JSON.stringify({ apiVersion: exec.apiVersion, kind: "ExecCredential", spec: { interactive: false } });
  const r = spawnSync(String(exec.command), (Array.isArray(exec.args) ? exec.args : []).map(String), {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error || r.status !== 0) throw new ReadError(`kubeconfig exec plugin ${exec.command} failed: ${r.error?.message ?? (r.stderr ?? "").trim().split("\n")[0]}`);
  let status: unknown;
  try {
    status = (JSON.parse(r.stdout) as { status?: unknown }).status;
  } catch {
    throw new ReadError(`kubeconfig exec plugin ${exec.command} returned no ExecCredential`);
  }
  if (!isRecord(status)) throw new ReadError(`kubeconfig exec plugin ${exec.command} returned no credential status`);
  if (typeof status.token === "string") conn.token = status.token;
  if (typeof status.clientCertificateData === "string") conn.tls.cert = status.clientCertificateData;
  if (typeof status.clientKeyData === "string") conn.tls.key = status.clientKeyData;
}

/** GET one API path; undefined on 404. The only HTTP method this script uses. */
function get(conn: Connection, path: string, query: Record<string, string> = {}): Promise<unknown> {
  const url = new URL(conn.server.pathname.replace(/\/$/, "") + path, conn.server);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const request = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((ok, fail) => {
    const req = request(
      url,
      {
        method: "GET",
        headers: { accept: "application/json", ...(conn.token ? { authorization: `Bearer ${conn.token}` } : {}) },
        timeout: 30_000,
        ...(url.protocol === "https:" ? conn.tls : {}),
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (d: string) => (body += d));
        res.on("end", () => {
          if (res.statusCode === 404) return ok(undefined);
          if (res.statusCode !== 200) {
            let message = body.trim().split("\n")[0] ?? "";
            try {
              message = String((JSON.parse(body) as { message?: unknown }).message ?? message);
            } catch {}
            return fail(new ReadError(`GET ${url.pathname}${url.search}: HTTP ${res.statusCode}: ${message}`));
          }
          try {
            ok(JSON.parse(body));
          } catch {
            fail(new ReadError(`GET ${url.pathname}${url.search} returned something other than JSON`));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (err) => fail(new ReadError(`GET ${url.pathname}: ${err.message}`)));
    req.end();
  });
}

/** List every item at a collection path through the bounded pager. */
function list(conn: Connection, what: string, path: string, query: Record<string, string> = {}): Promise<unknown[]> {
  return listAll(what, async (cont) => {
    const l = await get(conn, path, { ...query, limit: String(PAGE_LIMIT), ...(cont ? { continue: cont } : {}) });
    if (!isRecord(l) || !Array.isArray(l.items)) throw new ReadError(`GET ${path} (${what}) returned no list`);
    return { items: l.items, continue: isRecord(l.metadata) && typeof l.metadata.continue === "string" ? l.metadata.continue : undefined };
  });
}

// ---------------------------------------------------------------------------
// The four preconditions.

interface Verdict {
  ok: boolean;
  lines: string[];
}

const conditionsOf = (o: unknown): Array<Record<string, any>> =>
  isRecord(o) && isRecord(o.status) && Array.isArray(o.status.conditions) ? o.status.conditions.filter(isRecord) : [];
const describe = (c: Record<string, any>) => `${c.type}=${c.status}${c.reason ? ` (${c.reason}${c.message ? `: ${String(c.message).split("\n")[0]}` : ""})` : ""}`;

async function populatedDataStore(conn: Connection): Promise<Verdict> {
  const at = `Job ${NAMESPACE}/${IMPORT_JOB}`;
  const job = await get(conn, `/apis/batch/v1/namespaces/${NAMESPACE}/jobs/${IMPORT_JOB}`);
  if (job === undefined) return { ok: false, lines: [`${at}: absent; the history import has not run`] };
  const conds = conditionsOf(job);
  const complete = conds.find((c) => c.type === "Complete" && c.status === "True");
  if (complete) return { ok: true, lines: [`${at} is Complete${complete.lastTransitionTime ? ` since ${complete.lastTransitionTime}` : ""}`] };
  const held = conds.filter((c) => c.status === "True").map(describe);
  const active = isRecord(job) && isRecord(job.status) ? job.status.active : undefined;
  return {
    ok: false,
    lines: [`${at}: not Complete; ${held.length > 0 ? `conditions ${held.join(", ")}` : `no condition yet${active ? `, ${active} pod(s) active` : ""}`}`],
  };
}

async function workloadImagePulls(conn: Connection): Promise<Verdict> {
  const app = await get(conn, `/apis/argoproj.io/v1alpha1/namespaces/${APP.namespace}/applications/${APP.name}`);
  const podLists: Record<string, unknown> = {};
  for (const w of WORKLOADS) {
    const items = await list(conn, `pods of ${w.id}`, `/api/v1/namespaces/${NAMESPACE}/pods`, { labelSelector: `app.kubernetes.io/name=${w.label}` });
    podLists[w.id] = { items };
  }
  const r = checkImagePull(app, podLists);
  return r.mismatches.length > 0 ? { ok: false, lines: r.mismatches } : { ok: true, lines: r.ok };
}

async function runtimeSecrets(conn: Connection): Promise<Verdict> {
  const items = await list(conn, `ExternalSecrets in ${NAMESPACE}`, `/apis/external-secrets.io/v1/namespaces/${NAMESPACE}/externalsecrets`);
  if (items.length === 0) return { ok: false, lines: [`namespace ${NAMESPACE}: no ExternalSecret; the runtime secrets are not synced`] };
  const ready: string[] = [];
  const notReady: string[] = [];
  for (const es of items) {
    const name = `${NAMESPACE}/${isRecord(es) && isRecord(es.metadata) ? es.metadata.name : "<unnamed>"}`;
    const cond = conditionsOf(es).find((c) => c.type === "Ready");
    if (cond?.status === "True") ready.push(`ExternalSecret ${name} is Ready`);
    else notReady.push(`ExternalSecret ${name}: not Ready; ${cond ? describe(cond) : "no Ready condition"}`);
  }
  return notReady.length > 0 ? { ok: false, lines: notReady } : { ok: true, lines: ready };
}

async function singleWriter(conn: Connection): Promise<Verdict> {
  const apps = await list(conn, "Argo CD Applications", "/apis/argoproj.io/v1alpha1/applications");
  const targeting = apps
    .filter(isRecord)
    .filter((a) => isRecord(a.spec) && isRecord(a.spec.destination) && a.spec.destination.namespace === NAMESPACE)
    .map((a) => `${a.metadata?.namespace ?? ""}/${a.metadata?.name ?? "<unnamed>"}`);
  const want = `${APP.namespace}/${APP.name}`;
  if (targeting.length === 0) return { ok: false, lines: [`no Argo CD Application targets namespace ${NAMESPACE}; expected ${want}`] };
  if (targeting.length > 1) return { ok: false, lines: [`${targeting.length} Argo CD Applications target namespace ${NAMESPACE}: ${targeting.join(", ")}; expected only ${want}`] };
  if (targeting[0] !== want) return { ok: false, lines: [`the one Argo CD Application targeting namespace ${NAMESPACE} is ${targeting[0]}, not ${want}`] };
  return { ok: true, lines: [`Argo CD Application ${want} is the only one targeting namespace ${NAMESPACE}`] };
}

export const PRECONDITIONS: ReadonlyArray<{ name: string; check: (conn: Connection) => Promise<Verdict> }> = [
  { name: "populated data store", check: populatedDataStore },
  { name: "workload image pulls", check: workloadImagePulls },
  { name: "runtime secrets", check: runtimeSecrets },
  { name: "single writer", check: singleWriter },
];

const USAGE = "usage: node deploy/estate/check-cutover-preconditions.ts --kubeconfig <path> [--context <name>]\n";

async function main(argv: string[]): Promise<number> {
  const opts: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]!;
    const value = argv[i + 1];
    if ((flag !== "--kubeconfig" && flag !== "--context") || value === undefined || flag.slice(2) in opts) {
      process.stderr.write(USAGE);
      return 2;
    }
    opts[flag.slice(2)] = value;
  }
  if (opts.kubeconfig === undefined) {
    process.stderr.write(USAGE);
    return 2;
  }
  const passed: string[] = [];
  try {
    const conn = readKubeconfig(opts.kubeconfig, opts.context);
    for (const p of PRECONDITIONS) {
      const v = await p.check(conn);
      if (!v.ok) {
        for (const line of v.lines) process.stderr.write(`${p.name}: ${line}\n`);
        process.stderr.write(`precondition failed: ${p.name}\n`);
        return 1;
      }
      passed.push(...v.lines.map((line) => `${p.name}: ${line}`), `precondition holds: ${p.name}`);
    }
  } catch (err) {
    if (!(err instanceof ReadError || err instanceof ImageReadError || err instanceof PagerError)) throw err;
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  for (const line of passed) process.stdout.write(`${line}\n`);
  process.stdout.write(`all ${PRECONDITIONS.length} cutover preconditions hold on ${CLUSTER} for namespace ${NAMESPACE}\n`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
