// CR-D1-IMAGE acceptance: .github/workflows/publish.yml builds the ranker
// image once per merge to main on the owner's self-hosted runners and pushes
// it to ghcr.io/noncelogic/corpus-ranker tagged with the commit SHA, using
// the repository's own GITHUB_TOKEN with `packages: write` as its only write
// scope.
//
// Self-hosted runners hold estate credentials (docs/EXTERNAL-REVIEW.md §1),
// so the workflow must not be reachable from pull requests at all. ci.yml
// stays on GitHub-hosted runners and no longer publishes, so each merge
// yields exactly one publish.
//
// The workflow YAML is inspected with a narrow line scanner rather than a
// YAML library, to avoid a new dependency (docs/EXTERNAL-REVIEW.md §3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowsDir = resolve(repoRoot, ".github", "workflows");
const IMAGE = "ghcr.io/noncelogic/corpus-ranker";

/** Drop full-line and trailing comments so prose cannot satisfy a check. */
function stripComments(yaml: string): string {
  return yaml
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+#.*$/, ""))
    .join("\n");
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** The lines nested under the first `key:` found at the given indent. */
function block(yaml: string, key: string, indent: number): string[] {
  const lines = yaml.split("\n");
  const start = lines.findIndex(
    (line) => indentOf(line) === indent && line.trimStart().startsWith(`${key}:`),
  );
  if (start < 0) return [];
  const out = [lines[start]!];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() !== "" && indentOf(line) <= indent) break;
    out.push(line);
  }
  return out;
}

/** `name: value` pairs of a flat map block (its first line is the key). */
function mapEntries(lines: string[]): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const m = /^\s+([\w-]+):\s*(\S.*)?$/.exec(line);
    if (m) entries[m[1]!] = (m[2] ?? "").trim();
  }
  return entries;
}

/** Split `jobs:` into its job blocks, keyed by job id. */
function jobs(yaml: string): Map<string, string> {
  const lines = block(yaml, "jobs", 0).slice(1);
  const out = new Map<string, string>();
  let current: string | undefined;
  for (const line of lines) {
    const m = /^ {2}([\w-]+):\s*$/.exec(line);
    if (m) {
      current = m[1]!;
      out.set(current, "");
      continue;
    }
    if (current) out.set(current, `${out.get(current)}${line}\n`);
  }
  return out;
}

const publish = stripComments(readFileSync(resolve(workflowsDir, "publish.yml"), "utf8"));

test("the publish workflow triggers on push to main, runs on self-hosted runners and pushes a SHA-tagged image to ghcr.io/noncelogic/corpus-ranker with packages write permission only", () => {
  // Trigger: push to main, and nothing else (in particular, never a PR).
  const on = block(publish, "on", 0);
  assert.ok(on.length > 0, "publish.yml has an `on:` block");
  const triggers = on
    .slice(1)
    .filter((line) => indentOf(line) === 2)
    .map((line) => line.trim().replace(/:.*$/, ""));
  assert.deepEqual(triggers, ["push"], "only `push` triggers the publish workflow");
  const branches = on.join("\n").match(/branches:\s*\[([^\]]*)\]/)?.[1];
  assert.equal(branches?.split(",").map((b) => b.trim()).join(","), "main", "push is limited to main");
  assert.doesNotMatch(publish, /pull_request|workflow_run|repository_dispatch/);

  // Token scope: workflow default is none; the job grants packages: write
  // plus read-only contents for checkout, and nothing else writable.
  assert.deepEqual(mapEntries(block(publish, "permissions", 0)), {}, "top-level permissions are empty");
  assert.match(publish, /^permissions:\s*\{\}\s*$/m);

  const all = jobs(publish);
  assert.equal(all.size, 1, "exactly one job: the image is built once per merge");
  const [, job] = [...all][0]!;
  const jobYaml = `job:\n${job}`;

  assert.match(job, /^ {4}runs-on:\s*\[\s*self-hosted\b[^\]]*\]\s*$/m, "job runs on self-hosted runners");

  const perms = mapEntries(block(jobYaml, "permissions", 4));
  assert.deepEqual(perms, { contents: "read", packages: "write" });
  const writes = Object.entries(perms).filter(([, v]) => v === "write").map(([k]) => k);
  assert.deepEqual(writes, ["packages"], "packages is the only write scope");

  // Credentials: the repository's own GITHUB_TOKEN, not a PAT or other secret.
  const secrets = [...publish.matchAll(/secrets\.([\w-]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(secrets)], ["GITHUB_TOKEN"]);
  assert.match(publish, /docker login ghcr\.io\b[^\n]*--password-stdin/);

  // Build once, tag with the commit SHA, push that tag to GHCR.
  assert.match(publish, new RegExp(`IMAGE:\\s*${IMAGE.replace(/\./g, "\\.")}\\s*$`, "m"));
  assert.equal(publish.match(/docker build\b/g)?.length, 1, "one docker build");
  assert.match(publish, /-t "\$\{IMAGE\}:sha-\$\{GITHUB_SHA\}"/);
  assert.match(publish, /docker push "\$\{IMAGE\}:sha-\$\{GITHUB_SHA\}"/);
});

test("ci.yml no longer publishes, so each merge to main pushes the image exactly once", () => {
  const ci = stripComments(readFileSync(resolve(workflowsDir, "ci.yml"), "utf8"));
  assert.doesNotMatch(ci, /docker push|docker login/);
  assert.doesNotMatch(ci, /packages:\s*write/);
  assert.doesNotMatch(ci, /self-hosted/, "ci.yml (which runs PRs) stays off self-hosted runners");
});
