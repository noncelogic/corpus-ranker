// CR-M3-D1-JOB acceptance: the one-shot import Job ranker-corpus-import
// (deploy/import/, a kustomize component the normal sync never renders) loads
// Juno's staged weekly papers into the deployed ranker (SPEC A7 Phase 0).
//
// Part 1 renders the component and holds the Job's shape: PVC
// juno-papers-export mounted read-only at /import in every container, an init
// container that runs `sha256sum -c SHA256SUMS` there before the importer may
// start, the importer posting to the ranker-api Service with the API key from
// the ranker-api-keys Secret, and no retry.
//
// Part 2 runs the Job's own commands, as rendered, over a staged export in a
// temp dir: the init container's shell command under `sh`, then the importer's
// entry module (src/import/corpus-import-job.ts, which the image ships as
// dist/import/corpus-import-job.js) against a local HTTP server standing in
// for ranker-api. The stand-in checks capture against the frozen contract and
// answers it content-addressed (201 new, 200 same bytes); score posts go
// through the service's own handler (src/api/score.ts) over an in-memory
// store, so its contract check and the scored_at it would store are the real
// ones.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { score as scoreHandler } from "../../src/api/score.ts";
import { loadContracts, openapiUri } from "../../src/contracts/index.ts";
import type { Queryable } from "../../src/db/client.ts";
import { runCorpusImport } from "../../src/import/corpus-import-job.ts";
import { paperRubricV1 } from "../../src/import/paper-rubric.ts";
import { renderOptInJob } from "../../deploy/opt-in-job.ts";
import { deployDir, parseYamlDocs, renderObjects, repoRoot, type K8sObject } from "./render.ts";

const NAMESPACE = "corpus-ranker";
const JOB = "ranker-corpus-import";
const PVC = "juno-papers-export";
const WEEKS = ["W41", "W42", "W43", "W44", "W45", "W46", "W47"].map((w) => `papers-2026-${w}.jsonl`);
const CORPUS = /^\/v1\/corpora\/(cr_corpus_[A-Za-z0-9]+)\/originals$/;

interface Container {
  name: string;
  image: string;
  command: string[];
  args?: string[];
  workingDir?: string;
  env?: Array<{ name: string; value?: string; valueFrom?: any }>;
  volumeMounts?: Array<{ name: string; mountPath: string; readOnly?: boolean }>;
}

/** Render deploy/import through its documented path (deploy/opt-in-job.ts), as an operator applies it. */
function renderComponent(): K8sObject[] {
  return parseYamlDocs(renderOptInJob("corpus-import", "sha-535bf267131c58c223a3577c770fe4bb1a4b9528")) as unknown as K8sObject[];
}

const containersOf = (job: K8sObject): { init: Container[]; main: Container[] } => ({
  init: (job.spec.template.spec.initContainers ?? []) as Container[],
  main: job.spec.template.spec.containers as Container[],
});
const envOf = (c: Container, name: string) => (c.env ?? []).find((e) => e.name === name);

// ---------------------------------------------------------------------------
// A staged export and a stand-in ranker-api.

interface Rec {
  arxiv_id: string;
  title: string;
  abstract: string;
  scores?: Record<string, number>;
  scorer?: unknown;
  model?: string;
  scored_at?: string;
}

/** One week's records: a scored one (string scorer, bare date), a judge-scored one, an unscored one. */
function weekRecords(week: number): Rec[] {
  const day = String(week - 40).padStart(2, "0");
  return [
    {
      arxiv_id: `2610.${week}001`,
      title: `Secret Title ${week}A`,
      abstract: `PRIVATE-ABSTRACT-${week}-A`,
      scores: { relevance: 5, technical_merit: 4 },
      scorer: "joe",
      scored_at: `2026-10-${day}`,
    },
    {
      arxiv_id: `2610.${week}002`,
      title: `Secret Title ${week}B`,
      abstract: `PRIVATE-ABSTRACT-${week}-B`,
      scores: { relevance: 3, technical_merit: 3 },
      scorer: "program:paper-judge",
      model: "claude-opus-4-1",
      scored_at: `2026-10-${day}T09:15:00Z`,
    },
    { arxiv_id: `2610.${week}003`, title: `Secret Title ${week}C`, abstract: `PRIVATE-ABSTRACT-${week}-C` },
  ];
}

function stageExport(): string {
  const dir = mkdtempSync(join(tmpdir(), "cr-import-export-"));
  const sums: string[] = [];
  WEEKS.forEach((file, i) => {
    const body = weekRecords(41 + i).map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(join(dir, file), body);
    sums.push(`${createHash("sha256").update(body).digest("hex")}  ${file}`);
  });
  writeFileSync(join(dir, "registry.json"), JSON.stringify({ weeks: WEEKS }) + "\n");
  sums.push(`${createHash("sha256").update(readFileSync(join(dir, "registry.json"))).digest("hex")}  registry.json`);
  writeFileSync(join(dir, "SHA256SUMS"), sums.join("\n") + "\n");
  return dir;
}

interface Call {
  kind: "capture" | "score";
  body: any;
  /** The stand-in's answer. */
  body_out: any;
  auth: string | undefined;
  status: number;
}

interface StoredScore {
  item_id: string;
  scorer: unknown;
  scored_at: string;
}

interface FakeApi {
  url: string;
  calls: Call[];
  /** Score events as the handler's insert would store them, by id. */
  stored: Map<string, StoredScore>;
  /** arXiv IDs whose Item the ranker does not hold (the handler answers 404). */
  missingItems: Set<string>;
  close: () => Promise<void>;
}

const registry = loadContracts().registry;
const shortId = (prefix: string, ...parts: string[]) =>
  `${prefix}${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)}`;

const NOW = new Date("2026-11-20T12:00:00Z");
const policy = paperRubricV1({ corpusId: "cr_corpus_papers", createdBy: "joe", createdAt: "2026-10-01T00:00:00Z" });

/**
 * The ranker database as the score handler queries it: the paper-rubric v1
 * Policy, every Item but the missing ones, and score_events inserts kept as
 * their parameters would be stored.
 */
function scoreDb(stored: Map<string, StoredScore>, missingItems: Set<string>): Queryable {
  return {
    async query(text: string, params: readonly unknown[] = []) {
      if (/^\s*select json_build_object/.test(text)) {
        const [policyId, version, itemId] = params as [string, number, string];
        const exists = policyId === policy.id;
        const missing = [...missingItems].some((arxiv) => shortId("cr_item_", "cr_corpus_papers", arxiv) === itemId);
        return [{ found: { policy: exists && version === 1 ? policy : null, policy_exists: exists, item_exists: !missing } }] as any;
      }
      if (/^\s*insert into score_events/.test(text)) {
        const [id, itemId, , , , scorer, scoredAt] = params as string[];
        stored.set(id!, { item_id: itemId!, scorer: JSON.parse(scorer!), scored_at: new Date(scoredAt!).toISOString() });
        return [{ id }] as any;
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

async function fakeApi(): Promise<FakeApi> {
  const held = new Map<string, string>(); // corpus + hash -> original id
  const calls: Call[] = [];
  const stored = new Map<string, StoredScore>();
  const missingItems = new Set<string>();
  const db = scoreDb(stored, missingItems);
  let scoreSeq = 0;
  const read = (req: IncomingMessage) =>
    new Promise<string>((ok) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c)).on("end", () => ok(Buffer.concat(chunks).toString("utf8")));
    });
  const server = createServer(async (req, res) => {
    const raw = await read(req);
    const body = JSON.parse(raw);
    const path = new URL(req.url ?? "/", "http://x").pathname;
    const auth = req.headers.authorization;
    const answer = (kind: Call["kind"], status: number, out: unknown) => {
      calls.push({ kind, body, body_out: out, auth, status });
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(out));
    };
    const capture = CORPUS.exec(path);
    if (req.method === "POST" && capture) {
      const problems = registry.validate(body, `${openapiUri()}#/components/schemas/CaptureRequest`);
      if (problems.length > 0) return answer("capture", 400, { error: "invalid_request" });
      const hash = createHash("sha256").update(Buffer.from(body.content_base64, "base64")).digest("hex");
      const key = `${capture[1]}\0${hash}`;
      const existing = held.get(key);
      const id = existing ?? shortId("cr_orig_", capture[1]!, hash);
      held.set(key, id);
      return answer("capture", existing ? 200 : 201, { id, corpus_id: capture[1], content_hash: hash });
    }
    if (req.method === "POST" && path === "/v1/scores") {
      // The service's own handler: its contract check, policy rules and insert.
      const out = await scoreHandler(raw, { db, now: () => NOW, newId: () => `cr_score_${++scoreSeq}` });
      return answer("score", out.status, out.body);
    }
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    stored,
    missingItems,
    close: () => new Promise((ok) => server.close(() => ok())),
  };
}

interface RunResult {
  status: number | null;
  output: string;
}

/** Run the rendered Job's containers in order over `dir`: the init container must pass before the importer starts. */
async function runJob(job: K8sObject, dir: string, api: FakeApi): Promise<RunResult & { importerRan: boolean }> {
  const { init, main } = containersOf(job);
  let output = "";
  for (const c of init) {
    const [cmd, ...args] = [...c.command, ...(c.args ?? [])];
    assert.equal(cmd, "sh", `${c.name}: a shell step`);
    const script = args[args.length - 1]!.replaceAll("/import", dir);
    const r = spawnSync("sh", ["-c", script], { encoding: "utf8" });
    output += r.stdout + r.stderr;
    if (r.status !== 0) return { status: r.status, output, importerRan: false };
  }
  const [importer] = main;
  const argv = [...importer!.command, ...(importer!.args ?? [])];
  assert.deepEqual(argv, ["node", "dist/import/corpus-import-job.js"], "the importer runs the shipped entry module");
  const env: Record<string, string> = { PATH: process.env.PATH ?? "" };
  for (const e of importer!.env ?? []) if (e.value !== undefined) env[e.name] = e.value;
  env.RANKER_IMPORT_DIR = dir;
  env.RANKER_API_URL = api.url;
  env.RANKER_API_KEY = "test-key-for-joe";
  const child = spawn(process.execPath, [resolve(repoRoot, "src/import/corpus-import-job.ts")], { env });
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  const status = await new Promise<number | null>((ok) => child.on("close", ok));
  return { status, output, importerRan: true };
}

// ---------------------------------------------------------------------------

test("the rendered import Job mounts juno-papers-export read-only, checks SHA256SUMS, and runs capture then score for each record", async (t: TestContext) => {
  // --- Shape -------------------------------------------------------------------
  const objects = renderComponent();
  const job = objects.find((o) => o.kind === "Job" && o.metadata.name === JOB);
  assert.ok(job, "the component renders Job/ranker-corpus-import");
  assert.equal(job.metadata.namespace, NAMESPACE);
  assert.equal(job.metadata.annotations?.["argocd.argoproj.io/hook"], undefined, "not an Argo hook: an operator runs it once");
  assert.equal(Number(job.spec.backoffLimit), 0, "one-shot: a failed run is not retried (a retry would post scores again)");
  assert.equal(job.spec.template.spec.restartPolicy, "Never");
  assert.ok(Number(job.spec.activeDeadlineSeconds) > 0, "a bounded deadline");

  const volumes = job.spec.template.spec.volumes as Array<{ name: string; persistentVolumeClaim?: { claimName: string; readOnly?: boolean } }>;
  const exportVolume = volumes.find((v) => v.persistentVolumeClaim?.claimName === PVC);
  assert.ok(exportVolume, `the Job mounts PVC ${PVC}`);
  assert.equal(exportVolume.persistentVolumeClaim!.readOnly, true, "the claim is attached read-only");

  const { init, main } = containersOf(job);
  assert.equal(main.length, 1, "one importer container");
  for (const c of [...init, ...main]) {
    const mount: NonNullable<Container["volumeMounts"]>[number] | undefined = (c.volumeMounts ?? []).find((m) => m.name === exportVolume.name);
    assert.ok(mount, `${c.name}: mounts the export`);
    assert.equal(mount.mountPath, "/import", `${c.name}: at /import`);
    assert.equal(mount.readOnly, true, `${c.name}: read-only`);
  }

  // The checksum gate is an init container: the importer cannot start unless it passes.
  const verify = init.find((c) => /sha256sum -c SHA256SUMS/.test([...c.command, ...(c.args ?? [])].join(" ")));
  assert.ok(verify, "an init container runs sha256sum -c SHA256SUMS");
  assert.match([...verify.command, ...(verify.args ?? [])].join(" "), /cd \/import\b/, "the check runs in /import");

  const [importer] = main;
  assert.equal(envOf(importer!, "RANKER_IMPORT_DIR")?.value, "/import");
  assert.equal(envOf(importer!, "RANKER_API_URL")?.value, `http://ranker-api.${NAMESPACE}.svc.cluster.local:8080`, "posts to the ranker-api Service");
  assert.match(envOf(importer!, "RANKER_CORPUS_ID")?.value ?? "", /^cr_corpus_[A-Za-z0-9]+$/);
  assert.deepEqual(envOf(importer!, "RANKER_API_KEY")?.valueFrom, { secretKeyRef: { name: "ranker-api-keys", key: "joe" } }, "the API key comes from the ranker-api-keys Secret");
  assert.equal(importer!.image, "noncelogicci.azurecr.io/corpus-ranker:sha-535bf267131c58c223a3577c770fe4bb1a4b9528", "runs the published ranker image");

  // --- Not part of the normal sync -------------------------------------------
  assert.deepEqual(
    renderObjects().filter((o) => o.metadata.name === JOB).map((o) => o.kind),
    [],
    "deploy/kustomization.yaml does not render the import Job",
  );
  assert.doesNotMatch(readFileSync(resolve(deployDir, "kustomization.yaml"), "utf8"), /^\s*-\s*\.?\/?import\b/m);

  // --- Behaviour: one clean run ---------------------------------------------
  const dir = stageExport();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const api = await fakeApi();
  t.after(api.close);

  const first = await runJob(job, dir, api);
  assert.equal(first.status, 0, first.output);
  const total = WEEKS.length * 3;
  const scored = WEEKS.length * 2;
  assert.equal(api.calls.filter((c) => c.kind === "capture").length, total, "every record is captured");
  assert.equal(api.calls.filter((c) => c.kind === "score").length, scored, "every scored record's score is posted");
  assert.ok(api.calls.every((c) => c.auth === "Bearer test-key-for-joe"), "every post carries the API key");

  // Capture then score, record by record, in file order.
  const lines = WEEKS.flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean));
  let i = 0;
  for (const line of lines) {
    const cap = api.calls[i++]!;
    assert.equal(cap.kind, "capture");
    assert.equal(Buffer.from(cap.body.content_base64, "base64").toString("utf8"), line, "the record's exact bytes are captured");
    assert.equal(cap.body.media_type, "application/json");
    const rec = JSON.parse(line) as Rec;
    if (rec.scores === undefined) continue;
    const sc = api.calls[i++]!;
    assert.equal(sc.kind, "score", `the score follows its record's capture (${rec.arxiv_id})`);
    assert.equal(sc.body.policy_id, "cr_pol_paper");
    assert.equal(sc.body.policy_version, 1);
    assert.equal(sc.body.item_id, shortId("cr_item_", "cr_corpus_papers", rec.arxiv_id));
    const originalId = shortId("cr_orig_", "cr_corpus_papers", createHash("sha256").update(line).digest("hex"));
    assert.deepEqual(
      sc.body.dimension_scores.map((d: any) => [d.dimension, d.value, d.evidence]),
      [
        ["Relevance", rec.scores.relevance, [{ id: originalId }]],
        ["Technical Merit", rec.scores.technical_merit, [{ id: originalId }]],
      ],
      "paper-rubric v1 scores cite the captured Original",
    );
    // Scorer and date come from the file.
    const expectedScorer = rec.model ? { identity: rec.scorer, model: rec.model } : { identity: rec.scorer };
    assert.deepEqual(sc.body.scorer, expectedScorer, "the file's scorer is kept");
    assert.equal(sc.status, 201, `the ranker records the score (${rec.arxiv_id})`);
    const fileDate = new Date(rec.scored_at!.length === 10 ? `${rec.scored_at}T00:00:00Z` : rec.scored_at!).toISOString();
    assert.deepEqual(
      api.stored.get(sc.body_out.score_event_id),
      { item_id: sc.body.item_id, scorer: expectedScorer, scored_at: fileDate },
      "the ranker stores the file's scorer and date, not the time of the import",
    );
  }
  assert.equal(i, api.calls.length);

  // Counts only: never a record's contents.
  assert.match(first.output, new RegExp(`"records":${total}\\b`));
  assert.match(first.output, new RegExp(`"originals_created":${total}\\b`));
  assert.match(first.output, /"duplicates":0\b/);
  assert.match(first.output, new RegExp(`"scores":${scored}\\b`));
  assert.doesNotMatch(first.output, /PRIVATE-ABSTRACT|Secret Title|2610\.\d{5}/, "no record contents in the log");

  // --- must_allow: a re-run over the same files creates no duplicate Originals
  api.calls.length = 0;
  const again = await runJob(job, dir, api);
  assert.equal(again.status, 0, again.output);
  assert.ok(api.calls.filter((c) => c.kind === "capture").every((c) => c.status === 200), "every capture finds the existing Original");
  assert.match(again.output, /"originals_created":0\b/);
  assert.match(again.output, new RegExp(`"duplicates":${total}\\b`));

  // --- must_catch: a score answered 4xx is not counted as imported ------------
  api.calls.length = 0;
  api.missingItems.add("2610.43001");
  const failing = await runJob(job, dir, api);
  assert.notEqual(failing.status, 0, "a refused score post fails the Job");
  assert.match(failing.output, new RegExp(`"scores":${scored - 1}\\b`), "the refused score is not counted");
  assert.match(failing.output, /"failed":1\b/);
  assert.doesNotMatch(failing.output, /PRIVATE-ABSTRACT|Secret Title|2610\.\d{5}/);
  api.missingItems.clear();

  // --- must_catch: a SHA256SUMS mismatch posts nothing ------------------------
  api.calls.length = 0;
  const w44 = join(dir, WEEKS[3]!);
  writeFileSync(w44, readFileSync(w44, "utf8").replace("PRIVATE-ABSTRACT-44-A", "PRIVATE-ABSTRACT-44-X"));
  const tampered = await runJob(job, dir, api);
  assert.notEqual(tampered.status, 0, "the checksum gate fails");
  assert.equal(tampered.importerRan, false, "the importer never starts");
  assert.equal(api.calls.length, 0, "no record is posted");

  // The importer re-checks the sums itself, so it refuses even if started without the gate.
  // (spawn, not spawnSync: the stand-in API answers on this process's event loop.)
  const direct = spawn(process.execPath, [resolve(repoRoot, "src/import/corpus-import-job.ts")], {
    env: { PATH: process.env.PATH ?? "", RANKER_IMPORT_DIR: dir, RANKER_API_URL: api.url, RANKER_API_KEY: "k", RANKER_CORPUS_ID: "cr_corpus_papers" },
    stdio: "ignore",
  });
  const directStatus = await new Promise<number | null>((ok) => direct.on("close", ok));
  assert.notEqual(directStatus, 0);
  assert.equal(api.calls.length, 0, "the importer posts nothing over a mismatched export");
});

test("legacy Juno rubric fields fail before any HTTP write", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ranker-legacy-scores-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = WEEKS[0]!;
  const paper = JSON.stringify({ arxiv_id: "2610.00001", relevance: 5, technical_merit: 4 }) + "\n";
  writeFileSync(join(dir, file), paper);
  const checksum = createHash("sha256").update(paper).digest("hex");
  writeFileSync(join(dir, "SHA256SUMS"), `${checksum}  ${file}\n`);
  let requests = 0;
  await assert.rejects(runCorpusImport({
    dir,
    files: [file],
    apiUrl: "http://127.0.0.1",
    apiKey: "test",
    corpusId: "cr_corpus_papers",
    capturedBy: "agent:corpus-import",
    fetch: async () => {
      requests++;
      throw new Error("unexpected import request");
    },
  }), /1 record\(s\) have legacy top-level paper scores/);
  assert.equal(requests, 0);
});
