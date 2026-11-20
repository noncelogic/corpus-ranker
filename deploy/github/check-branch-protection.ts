#!/usr/bin/env node
// Read main's branch protection back from GitHub and check its required
// status checks are exactly the ones the repository declares
// (devops/github/branch-protection.json; policy main-stays-green: strict, and
// `ci-result`, the ci.yml job that needs every other ci.yml job):
//
//   node deploy/github/check-branch-protection.ts
//
// It reads, with the `gh` CLI and its token:
//
//   - GET repos/<repo>/branches/<branch> -- whether the branch is protected,
//     and its required status checks (contexts and checks) with their
//     enforcement level; readable with a read-only token;
//   - GET repos/<repo>/branches/<branch>/protection/required_status_checks --
//     `strict` (branch must be up to date before merging) and the required
//     checks again; needs a token with administration read.
//
// and compares the required check names both ways (a declared check that is
// not required, a required check that is not declared), `strict`, and that
// enforcement is not off. Exit 0: protection matches. Exit 1: each difference
// is named on stderr, one per line (also when part of the read failed). Exit
// 2: a read failed and nothing read so far differs, or a usage error.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const declaredFile = resolve(repoRoot, "devops", "github", "branch-protection.json");

export interface DeclaredProtection {
  repo: string;
  branch: string;
  required_status_checks: { strict: boolean; contexts: string[] };
}

export function loadDeclared(path: string = declaredFile): DeclaredProtection {
  const d = JSON.parse(readFileSync(path, "utf8")) as DeclaredProtection;
  const rsc = d.required_status_checks;
  if (
    typeof d.repo !== "string" ||
    typeof d.branch !== "string" ||
    typeof rsc?.strict !== "boolean" ||
    !Array.isArray(rsc.contexts) ||
    !rsc.contexts.every((c) => typeof c === "string")
  ) {
    throw new Error(`${path}: expected {repo, branch, required_status_checks: {strict, contexts[]}}`);
  }
  return d;
}

class ReadError extends Error {}

function ghApi(path: string): any {
  const r = spawnSync("gh", ["api", "-H", "Accept: application/vnd.github+json", path], { encoding: "utf8" });
  if (r.error) throw new ReadError(`gh api ${path}: ${r.error.message}`);
  if (r.status !== 0) throw new ReadError(`gh api ${path}: ${(r.stderr || r.stdout).trim()}`);
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new ReadError(`gh api ${path}: response is not JSON`);
  }
}

/** Required check names from a GitHub required_status_checks object (`checks[].context` and legacy `contexts`). */
function requiredNames(rsc: any): Set<string> {
  const names = new Set<string>();
  for (const c of Array.isArray(rsc?.contexts) ? rsc.contexts : []) if (typeof c === "string") names.add(c);
  for (const c of Array.isArray(rsc?.checks) ? rsc.checks : []) if (typeof c?.context === "string") names.add(c.context);
  return names;
}

function compareNames(where: string, want: string[], got: Set<string>): string[] {
  const drift: string[] = [];
  for (const c of [...want].sort()) if (!got.has(c)) drift.push(`${where}: status check ${JSON.stringify(c)} is declared but not required`);
  for (const c of [...got].sort()) if (!want.includes(c)) drift.push(`${where}: status check ${JSON.stringify(c)} is required but not declared`);
  return drift;
}

export function check(declared: DeclaredProtection): { drift: string[]; readErrors: string[] } {
  const { repo, branch } = declared;
  const want = declared.required_status_checks;
  const drift: string[] = [];
  const readErrors: string[] = [];
  const where = `${repo}@${branch}`;

  try {
    const b = ghApi(`repos/${repo}/branches/${branch}`);
    if (b?.protected !== true) drift.push(`${where}: branch is not protected`);
    const rsc = b?.protection?.required_status_checks;
    if (!rsc || rsc.enforcement_level === "off") drift.push(`${where}: required status checks are not enforced (enforcement_level ${JSON.stringify(rsc?.enforcement_level ?? null)})`);
    drift.push(...compareNames(where, want.contexts, requiredNames(rsc)));
  } catch (err) {
    if (!(err instanceof ReadError)) throw err;
    readErrors.push(err.message);
  }

  try {
    const rsc = ghApi(`repos/${repo}/branches/${branch}/protection/required_status_checks`);
    if (rsc?.strict !== want.strict) drift.push(`${where}: strict is ${JSON.stringify(rsc?.strict ?? null)}, declared ${want.strict}`);
    for (const d of compareNames(where, want.contexts, requiredNames(rsc))) if (!drift.includes(d)) drift.push(d);
  } catch (err) {
    if (!(err instanceof ReadError)) throw err;
    readErrors.push(err.message);
  }
  return { drift, readErrors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 2) {
    console.error("usage: node deploy/github/check-branch-protection.ts");
    process.exit(2);
  }
  const declared = loadDeclared();
  const { drift, readErrors } = check(declared);
  for (const e of readErrors) console.error(`read failed: ${e}`);
  for (const d of drift) console.error(d);
  if (drift.length > 0) process.exit(1);
  if (readErrors.length > 0) process.exit(2);
  console.log(
    `${declared.repo}@${declared.branch}: required status checks ${JSON.stringify(declared.required_status_checks.contexts)}, strict ${declared.required_status_checks.strict}: as declared`,
  );
}
