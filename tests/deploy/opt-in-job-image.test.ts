// CR-M3-OPTIN-IMAGE-PIN acceptance: every opt-in ranker Job that runs outside
// the Argo sync (deploy/history-import/job.yaml, policy-check-job.yaml, the
// deploy/import component and deploy/daily-import/job.yaml) renders through
// its documented path, `node deploy/opt-in-job.ts <job> sha-<commit>`, only
// with the operator-supplied immutable sha-<40-hex commit> tag that
// .github/workflows/publish.yml pushes, never untagged, :latest or :main
// (publish.yml pushes no moving tag).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { deployDir, parseYamlDocs, repoRoot, type K8sObject } from "./render.ts";

const IMAGE = "noncelogicci.azurecr.io/corpus-ranker";
const SCRIPT = resolve(deployDir, "opt-in-job.ts");
const TAG = "sha-535bf267131c58c223a3577c770fe4bb1a4b9528";

const JOBS: Record<string, { name: string; source: string }> = {
  "history-import": { name: "ranker-juno-history-import", source: "history-import/job.yaml" },
  "policy-check": { name: "ranker-juno-policy-check", source: "history-import/policy-check-job.yaml" },
  "corpus-import": { name: "ranker-corpus-import", source: "import/job.yaml" },
  "daily-import": { name: "ranker-daily-paper-import", source: "daily-import/job.yaml" },
};

const run = (...args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repoRoot, encoding: "utf8", env: process.env });

const containers = (job: K8sObject): Array<{ name: string; image: string }> => [
  ...(job.spec.template.spec.initContainers ?? []),
  ...job.spec.template.spec.containers,
];

test("each opt-in Job's ranker containers render with the supplied sha-<commit> tag and never untagged, :latest or :main", () => {
  for (const [job, { name, source }] of Object.entries(JOBS)) {
    const r = run(job, TAG);
    assert.equal(r.status, 0, `${job}: ${r.stderr}`);
    const objects = parseYamlDocs(r.stdout) as unknown as K8sObject[];
    const jobs = objects.filter((o) => o.kind === "Job");
    assert.deepEqual(jobs.map((o) => o.metadata.name), [name], `${job} renders exactly Job/${name}`);
    assert.equal(jobs[0]!.metadata.namespace, "corpus-ranker", `${job}: rendered into namespace corpus-ranker`);
    const cs = containers(jobs[0]!);
    assert.ok(cs.length > 0);
    // Every container the source names with the ranker image is rendered with the tag.
    const sourceRanker = (readFileSync(resolve(deployDir, source), "utf8").match(new RegExp(`image:\\s*${IMAGE.replaceAll(".", "\\.")}\\b`, "g")) ?? []).length;
    const pinned = cs.filter((c) => c.image === `${IMAGE}:${TAG}`);
    assert.equal(pinned.length, sourceRanker, `${job}: every ranker container carries ${TAG}`);
    for (const c of cs) {
      assert.match(c.image, /:sha-[0-9a-f]{40}$/, `${job}/${c.name}: an immutable sha-<commit> tag`);
      assert.doesNotMatch(c.image, /:(latest|main)$/, `${job}/${c.name}: no moving tag`);
      assert.notEqual(c.image, IMAGE, `${job}/${c.name}: not untagged`);
    }
  }
  // The component no longer carries a moving tag of its own.
  assert.doesNotMatch(readFileSync(resolve(deployDir, "import", "kustomization.yaml"), "utf8"), /newTag:\s*(main|latest)\b/);
});

test("rendering an opt-in Job without a sha-<commit> tag fails and names the missing tag", () => {
  const bad: string[][] = [
    [],
    ["history-import"],
    ["policy-check", "main"],
    ["corpus-import", "latest"],
    ["daily-import", "sha-535bf26"],
    ["history-import", `${IMAGE}:${TAG}`],
    ["policy-check", "sha-535BF267131C58C223A3577C770FE4BB1A4B9528"],
  ];
  for (const args of bad) {
    const r = run(...args);
    assert.notEqual(r.status, 0, `${JSON.stringify(args)} must fail`);
    assert.equal(r.stdout, "", `${JSON.stringify(args)}: nothing rendered to apply`);
    if (args.length === 0) continue; // usage error: no job named either
    assert.match(r.stderr, /sha-<40-hex commit> image tag/, `${JSON.stringify(args)}: names the missing tag`);
  }
  const unknown = run("no-such-job", TAG);
  assert.notEqual(unknown.status, 0);
  assert.equal(unknown.stdout, "");
});
