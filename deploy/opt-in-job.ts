#!/usr/bin/env node
// Render one opt-in ranker Job (a Job the Argo sync never renders, applied by
// hand) with an immutable published image tag:
//
//   node deploy/opt-in-job.ts <job> sha-<40-hex commit> | kubectl apply -n corpus-ranker -f -
//
// <job> is one of:
//   history-import  deploy/history-import/job.yaml (Job ranker-juno-history-import)
//   policy-check    deploy/history-import/policy-check-job.yaml (Job ranker-juno-policy-check)
//   corpus-import   the deploy/import component (Job ranker-corpus-import)
//   daily-import    deploy/daily-import/job.yaml (Job ranker-daily-paper-import)
//
// .github/workflows/publish.yml pushes only
// noncelogicci.azurecr.io/corpus-ranker:sha-<commit>, never a moving tag
// (:latest, :main), and the estate Argo Application's kustomize images pin
// reaches only what Argo renders. So the manifests name the ranker image
// untagged and this is the one documented way to apply them: it requires the
// operator to pass the sha-<commit> tag of a published commit, renders the Job
// through kustomize (`images:` newTag, namespace corpus-ranker) into a
// throwaway overlay, and checks every ranker container carries that tag before
// printing anything. Use the same tag for the policy check and the history
// import it gates.
//
// Exit 0: the rendered YAML is on stdout. Exit 2: usage error (no job, an
// unknown job, or a missing or malformed tag), named on stderr; nothing is
// printed to stdout. Exit 1: kustomize is missing or failed, or a rendered
// ranker container is not at the tag. Purely local: nothing here contacts a cluster or registry.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const IMAGE = "noncelogicci.azurecr.io/corpus-ranker";
export const NAMESPACE = "corpus-ranker";
const TAG = /^sha-[0-9a-f]{40}$/;
const deployDir = dirname(fileURLToPath(import.meta.url));

/** Each opt-in Job: a plain manifest (`resource`) or a kustomize Component directory (`component`). */
export const JOBS: Record<string, { resource: string } | { component: string }> = {
  "history-import": { resource: "history-import/job.yaml" },
  "policy-check": { resource: "history-import/policy-check-job.yaml" },
  "corpus-import": { component: "import" },
  "daily-import": { resource: "daily-import/job.yaml" },
};

class UsageError extends Error {}

function kustomizeBuild(dir: string): string {
  const candidates: Array<[string, string[]]> = [];
  if (process.env.KUSTOMIZE) candidates.push([process.env.KUSTOMIZE, ["build", dir]]);
  candidates.push(["kustomize", ["build", dir]], ["kubectl", ["kustomize", dir]]);
  for (const [cmd, args] of candidates) {
    try {
      return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw err;
    }
  }
  throw new Error("no kustomize found: install kustomize or kubectl, or set $KUSTOMIZE");
}

/** Render `job` with the ranker image at `tag`; throws UsageError on a bad job or tag. */
export function renderOptInJob(job: string | undefined, tag: string | undefined): string {
  const usage = `usage: node deploy/opt-in-job.ts <${Object.keys(JOBS).join("|")}> sha-<40-hex commit>`;
  if (job === undefined) throw new UsageError(`missing job\n${usage}`);
  const spec = JOBS[job];
  if (spec === undefined) throw new UsageError(`unknown job ${JSON.stringify(job)}\n${usage}`);
  if (tag === undefined || !TAG.test(tag)) {
    throw new UsageError(
      `${job}: ${tag === undefined ? "missing" : `invalid tag ${JSON.stringify(tag)}; need`} the sha-<40-hex commit> image tag ` +
        `of a commit publish.yml pushed as ${IMAGE}:sha-<commit> (no untagged, :latest or :main image is published)\n${usage}`,
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "cr-opt-in-job-"));
  try {
    let source: string;
    if ("resource" in spec) {
      // kustomize loads files only from inside the kustomization root.
      const file = basename(spec.resource);
      copyFileSync(resolve(deployDir, spec.resource), join(dir, file));
      source = `resources:\n  - ${file}\n`;
    } else {
      source = `components:\n  - ${relative(dir, resolve(deployDir, spec.component))}\n`;
    }
    writeFileSync(
      join(dir, "kustomization.yaml"),
      `apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nnamespace: ${NAMESPACE}\n${source}` +
        `images:\n  - name: ${IMAGE}\n    newTag: ${tag}\n`,
    );
    const out = kustomizeBuild(dir);
    const images = [...out.matchAll(/^\s*(?:-\s+)?image:\s*["']?([^\s"']+)/gm)].map((m) => m[1]!);
    const ranker = images.filter((i) => i === IMAGE || i.startsWith(`${IMAGE}:`) || i.startsWith(`${IMAGE}@`));
    if (ranker.length === 0) throw new Error(`${job}: rendered no ${IMAGE} container`);
    const wrong = ranker.filter((i) => i !== `${IMAGE}:${tag}`);
    if (wrong.length > 0) throw new Error(`${job}: rendered ranker image(s) not at ${tag}: ${wrong.join(", ")}`);
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(renderOptInJob(process.argv[2], process.argv[3]));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(err instanceof UsageError ? 2 : 1);
  }
}
