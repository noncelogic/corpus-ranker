// CR-M3-D1-JUNO-FORMAT acceptance: ranker-corpus-import scores Juno's weekly
// records as they are shaped. Juno's records carry relevance and
// technical_merit as top-level numbers, a verdict, and first_seen, but no
// scores object, scorer or scored_at. Such a record is scored with the
// Job-level declared scorer and scored_at = first_seen (provenance stated as
// reconstructed); a record naming its own scorer and scored_at keeps them.
//
// Score posts go through the service's own handler (src/api/score.ts), with
// paper-rubric v1 allowing the declared identity, so the contract check and
// the stored scorer and date are the real ones. The declared identity uses
// the contract's scorer pattern (juno:weekly-aggregation-triage; a "/" is
// refused by ScoreRequest).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { score as scoreHandler } from "../../src/api/score.ts";
import type { Queryable } from "../../src/db/client.ts";
import { parseDeclaredScorer, runCorpusImport } from "../../src/import/corpus-import-job.ts";
import { publishedPaperRubricV1 } from "../../src/import/juno-historical-import.ts";
import { paperRubricV1 } from "../../src/import/paper-rubric.ts";
import { deployDir, parseYamlDocs } from "../deploy/render.ts";

const FILE = "papers-2026-W45.jsonl";
const CORPUS = "cr_corpus_papers";
const DECLARED = {
  identity: "juno:weekly-aggregation-triage",
  config: { rubric: "paper-rubric v1", scored_at_from: "first_seen" },
};
const policy = paperRubricV1({
  corpusId: CORPUS,
  createdBy: "joe",
  createdAt: "2026-10-01T00:00:00Z",
  allowedScorers: [
    { kind: "human", identity: "joe" },
    { kind: "llm_judge", identity: "program:paper-judge" },
    { kind: "program", identity: DECLARED.identity },
  ],
});

function stage(t: TestContext, records: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "cr-juno-format-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const body = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(join(dir, FILE), body);
  writeFileSync(join(dir, "SHA256SUMS"), `${createHash("sha256").update(body).digest("hex")}  ${FILE}\n`);
  return dir;
}

interface Stored {
  scorer: unknown;
  scored_at: string;
}

/** A stand-in ranker-api: capture answers 201 with an id; scores go through the real handler. */
function standIn() {
  const scoreBodies: any[] = [];
  const stored: Stored[] = [];
  const db: Queryable = {
    async query(text: string, params: readonly unknown[] = []) {
      if (/^\s*select json_build_object/.test(text)) {
        return [{ found: { policy: params[0] === policy.id && params[1] === 1 ? policy : null, policy_exists: true, item_exists: true } }] as any;
      }
      if (/^\s*insert into score_events/.test(text)) {
        const [id, , , , , scorer, scoredAt] = params as string[];
        stored.push({ scorer: JSON.parse(scorer!), scored_at: new Date(scoredAt!).toISOString() });
        return [{ id }] as any;
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
  let seq = 0;
  const fetchStub = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const raw = String(init?.body ?? "");
    if (path.endsWith("/originals")) {
      return new Response(JSON.stringify({ id: `cr_orig_${++seq}` }), { status: 201 });
    }
    if (path === "/v1/scores") {
      scoreBodies.push(JSON.parse(raw));
      const out = await scoreHandler(raw, { db, now: () => new Date("2026-11-20T12:00:00Z"), newId: () => `cr_score_${++seq}` });
      return new Response(JSON.stringify(out.body), { status: out.status });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchStub, scoreBodies, stored };
}

const run = (dir: string, api: ReturnType<typeof standIn>, declaredScorer?: typeof DECLARED) =>
  runCorpusImport({
    dir,
    files: [FILE],
    apiUrl: "http://ranker-api.test",
    apiKey: "k",
    corpusId: CORPUS,
    capturedBy: "agent:corpus-import",
    fetch: api.fetch,
    log: () => {},
    ...(declaredScorer ? { declaredScorer } : {}),
  });

test("a Juno-shaped record with top-level scores and first_seen is scored with the declared scorer and first_seen date", async (t) => {
  const dir = stage(t, [
    {
      arxiv_id: "2611.04501",
      title: "Juno-shaped paper",
      first_seen: "2026-11-04",
      relevance: 4,
      technical_merit: 3,
      verdict: "Directly useful for agent memory work; solid evaluation.",
    },
  ]);
  const api = standIn();
  const counts = await run(dir, api, DECLARED);
  assert.deepEqual(
    { scores: counts.scores, unscored: counts.unscored, failed: counts.failed },
    { scores: 1, unscored: 0, failed: 0 },
    "scored, never counted unscored or failed",
  );
  const [body] = api.scoreBodies;
  assert.deepEqual(body.scorer, DECLARED, "the Job-level declared scorer");
  assert.equal(body.scored_at, "2026-11-04T00:00:00Z", "scored_at is first_seen");
  assert.deepEqual(
    body.dimension_scores.map((d: any) => [d.dimension, d.value, d.reason]),
    [
      ["Relevance", 4, "Directly useful for agent memory work; solid evaluation."],
      ["Technical Merit", 3, "Directly useful for agent memory work; solid evaluation."],
    ],
    "the top-level numbers, with the verdict as the reason",
  );
  assert.deepEqual(api.stored, [{ scorer: DECLARED, scored_at: "2026-11-04T00:00:00.000Z" }], "the ranker stores them");
});

test("a Juno-shaped record without a declared scorer fails before any write", async (t) => {
  const dir = stage(t, [{ arxiv_id: "2611.04501", first_seen: "2026-11-04", relevance: 4, technical_merit: 3 }]);
  const api = standIn();
  await assert.rejects(run(dir, api), /1 record\(s\) have legacy top-level paper scores/);
  assert.equal(api.scoreBodies.length, 0);
});

test("a record with its own scorer and scored_at keeps them", async (t) => {
  const own = { identity: "program:paper-judge", model: "test-fixture-model" };
  const dir = stage(t, [
    {
      arxiv_id: "2611.04502",
      first_seen: "2026-11-04",
      scores: { relevance: 5, technical_merit: 4 },
      scorer: own,
      scored_at: "2026-11-05T09:15:00Z",
    },
    {
      arxiv_id: "2611.04503",
      first_seen: "2026-11-04",
      relevance: 2,
      technical_merit: 2,
      verdict: "Tangential.",
      scorer: "joe",
      scored_at: "2026-11-06",
    },
  ]);
  const api = standIn();
  const counts = await run(dir, api, DECLARED);
  assert.equal(counts.scores, 2);
  assert.equal(counts.failed, 0);
  assert.deepEqual(api.scoreBodies.map((b) => [b.scorer, b.scored_at]), [
    [own, "2026-11-05T09:15:00Z"],
    [{ identity: "joe" }, "2026-11-06T00:00:00Z"],
  ]);
  assert.deepEqual(api.stored, [
    { scorer: own, scored_at: "2026-11-05T09:15:00.000Z" },
    { scorer: { identity: "joe" }, scored_at: "2026-11-06T00:00:00.000Z" },
  ]);
});

test("the import Job declares the scorer for records that name none", () => {
  const [job] = parseYamlDocs(readFileSync(join(deployDir, "import", "job.yaml"), "utf8")) as any[];
  const env = job.spec.template.spec.containers[0].env as Array<{ name: string; value?: string }>;
  const declared = env.find((e) => e.name === "RANKER_IMPORT_DECLARED_SCORER")?.value;
  assert.ok(declared, "the Job sets RANKER_IMPORT_DECLARED_SCORER");
  const scorer = parseDeclaredScorer(declared);
  assert.equal(scorer.identity, "juno:weekly-aggregation-triage");
  assert.deepEqual(
    { rubric: scorer.config?.rubric, scored_at_from: scorer.config?.scored_at_from },
    { rubric: "paper-rubric v1", scored_at_from: "first_seen" },
    "the config states the provenance as reconstructed from first_seen",
  );
  assert.throws(() => parseDeclaredScorer("{}"), /no identity/);
});

test("the scorer the import Job declares in deploy/import/job.yaml is admitted by the paper-rubric v1 the history import publishes", () => {
  const [job] = parseYamlDocs(readFileSync(join(deployDir, "import", "job.yaml"), "utf8")) as any[];
  const env = job.spec.template.spec.containers[0].env as Array<{ name: string; value?: string }>;
  const declared = parseDeclaredScorer(env.find((e) => e.name === "RANKER_IMPORT_DECLARED_SCORER")!.value!);
  assert.equal(declared.config?.rubric, "paper-rubric v1");
  assert.deepEqual([publishedPaperRubricV1.id, publishedPaperRubricV1.version], ["cr_pol_paper", 1]);
  assert.ok(
    publishedPaperRubricV1.judge_config.allowed_scorers.some((a) => a.identity === declared.identity),
    `${declared.identity} is among the published v1 allowed scorers`,
  );
});
