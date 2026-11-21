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
import { resolve } from "node:path";
import { deployDir, parseYamlDocs, repoRoot, type K8sObject } from "./render.ts";

const IMAGE = "noncelogicci.azurecr.io/corpus-ranker";
const SCRIPT = resolve(deployDir, "opt-in-job.ts");
const TAG = "sha-535bf267131c58c223a3577c770fe4bb1a4b9528";

// The rendered Job and every container it runs (init containers first), each
// of which runs the ranker image.
const JOBS: Record<string, { name: string; containers: string[] }> = {
  "history-import": { name: "ranker-juno-history-import", containers: ["verify", "import"] },
  "policy-check": { name: "ranker-juno-policy-check", containers: ["check-policy"] },
  "corpus-import": { name: "ranker-corpus-import", containers: ["verify", "import"] },
  "daily-import": { name: "ranker-daily-paper-import", containers: ["verify", "import"] },
};

const run = (...args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd: repoRoot, encoding: "utf8", env: process.env });

const containers = (job: K8sObject): Array<{ name: string; image: string }> => [
  ...(job.spec.template.spec.initContainers ?? []),
  ...job.spec.template.spec.containers,
];

test("each opt-in Job's ranker containers render with the supplied sha-<commit> tag and never untagged, :latest or :main", () => {
  for (const [job, { name, containers: expected }] of Object.entries(JOBS)) {
    const r = run(job, TAG);
    assert.equal(r.status, 0, `${job}: ${r.stderr}`);
    const objects = parseYamlDocs(r.stdout) as unknown as K8sObject[];
    const jobs = objects.filter((o) => o.kind === "Job");
    assert.deepEqual(jobs.map((o) => o.metadata.name), [name], `${job} renders exactly Job/${name}`);
    assert.equal(jobs[0]!.metadata.namespace, "corpus-ranker", `${job}: rendered into namespace corpus-ranker`);
    const cs = containers(jobs[0]!);
    // Exactly the expected ranker containers, each rendered with the supplied tag.
    assert.deepEqual(
      cs.map((c) => [c.name, c.image]),
      expected.map((c) => [c, `${IMAGE}:${TAG}`]),
      `${job}: containers ${expected.join(", ")} each carry ${TAG}`,
    );
    for (const c of cs) {
      assert.match(c.image, /:sha-[0-9a-f]{40}$/, `${job}/${c.name}: an immutable sha-<commit> tag`);
      assert.doesNotMatch(c.image, /:(latest|main)$/, `${job}/${c.name}: no moving tag`);
      assert.notEqual(c.image, IMAGE, `${job}/${c.name}: not untagged`);
    }
  }
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
