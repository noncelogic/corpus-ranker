// CR-D1 acceptance: `kustomize build deploy/` renders, and the API
// Deployment's env names match the frozen config contract read by
// src/config.ts (RANKER_PORT, RANKER_DATABASE_URL, RANKER_S3_ENDPOINT,
// RANKER_S3_BUCKET).
//
// Requires a kustomize binary: $KUSTOMIZE, `kustomize` on PATH, or
// `kubectl kustomize` (GitHub-hosted ubuntu runners ship both). Rendering is
// purely local; nothing here talks to a cluster.
//
// The rendered YAML is inspected with a narrow line scanner rather than a
// YAML library, to avoid a new dependency (docs/EXTERNAL-REVIEW.md §3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const deployDir = resolve(repoRoot, "deploy");

const CONTRACT = ["RANKER_PORT", "RANKER_DATABASE_URL", "RANKER_S3_ENDPOINT", "RANKER_S3_BUCKET"];

function tryRun(cmd: string, args: string[]): string | undefined {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function kustomizeBuild(dir: string): string {
  const candidates: Array<[string, string[]]> = [];
  if (process.env.KUSTOMIZE) candidates.push([process.env.KUSTOMIZE, ["build", dir]]);
  candidates.push(["kustomize", ["build", dir]], ["kubectl", ["kustomize", dir]]);
  for (const [cmd, args] of candidates) {
    const out = tryRun(cmd, args);
    if (out !== undefined) return out;
  }
  throw new Error("no kustomize found: install kustomize or kubectl, or set $KUSTOMIZE");
}

interface Doc {
  text: string;
  kind: string;
  name: string;
  namespace: string | undefined;
}

function splitDocs(yaml: string): Doc[] {
  return yaml
    .split(/^---\s*$/m)
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .map((text) => {
      const kind = /^kind: (\S+)$/m.exec(text)?.[1] ?? "";
      // metadata is a top-level map; its name/namespace sit at indent 2.
      const meta = /^metadata:\n((?: {2}.*\n?|\s*\n)*)/m.exec(text)?.[1] ?? "";
      const name = /^ {2}name: (\S+)$/m.exec(meta)?.[1] ?? "";
      const namespace = /^ {2}namespace: (\S+)$/m.exec(meta)?.[1];
      return { text, kind, name, namespace };
    });
}

const indentOf = (line: string): number => line.length - line.trimStart().length;

/** Names of the entries of every `env:` list in a document. */
function envNames(docText: string): string[] {
  const lines = docText.split("\n");
  const names: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?env:\s*$/.exec(lines[i]!);
    if (!m) continue;
    // `env:` may itself be the first key of a list item (`- env:`).
    const keyIndent = m[1]!.length + (lines[i]!.trimStart().startsWith("- ") ? 2 : 0);
    let itemIndent: number | undefined;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]!;
      if (line.trim() === "") continue;
      const ind = indentOf(line);
      const isItem = line.trimStart().startsWith("- ");
      if (ind < keyIndent || (ind === keyIndent && !isItem)) break;
      if (itemIndent === undefined) itemIndent = ind;
      if (ind < itemIndent) break;
      const first = new RegExp(`^ {${itemIndent}}- name: (\\S+)$`).exec(line);
      const later = new RegExp(`^ {${itemIndent + 2}}name: (\\S+)$`).exec(line);
      const hit = first ?? later;
      if (hit) names.push(hit[1]!.replace(/^["']|["']$/g, ""));
    }
  }
  return names;
}

let rendered: Doc[] | undefined;
const renderDocs = (): Doc[] => (rendered ??= splitDocs(kustomizeBuild(deployDir)));
const find = (kind: string, name: string): Doc => {
  const doc = renderDocs().find((d) => d.kind === kind && d.name === name);
  assert.ok(doc, `rendered manifests have no ${kind}/${name}`);
  return doc;
};

test("kustomize build renders and the Deployment env names match the frozen config contract (RANKER_PORT, RANKER_DATABASE_URL, RANKER_S3_ENDPOINT, RANKER_S3_BUCKET)", () => {
  const docs = renderDocs();
  assert.ok(docs.length > 0, "kustomize build rendered nothing");

  const deployment = find("Deployment", "ranker-api");
  const names = envNames(deployment.text);
  for (const name of CONTRACT) {
    assert.ok(names.includes(name), `Deployment env lacks ${name}; has ${JSON.stringify(names)}`);
  }
  assert.equal(new Set(names).size, names.length, `duplicate env names: ${JSON.stringify(names)}`);

  // Every RANKER_* name the Deployment sets must be one the service reads:
  // a typo would otherwise silently fall back to a localhost default.
  const configSrc = readFileSync(resolve(repoRoot, "src", "config.ts"), "utf8");
  const read = new Set([...configSrc.matchAll(/env\.(RANKER_[A-Z0-9_]+)/g)].map((m) => m[1]!));
  for (const name of CONTRACT) assert.ok(read.has(name), `src/config.ts no longer reads ${name}`);
  for (const name of names.filter((n) => n.startsWith("RANKER_"))) {
    assert.ok(read.has(name), `Deployment sets ${name}, which src/config.ts does not read`);
  }

  // Wiring: database URL from the CNPG app secret, object store at MinIO.
  assert.match(deployment.text, /name: RANKER_DATABASE_URL\n\s+valueFrom:\n\s+secretKeyRef:\n\s+(?:key: uri\n\s+name: ranker-db-app|name: ranker-db-app\n\s+key: uri)/);
  assert.match(deployment.text, /name: RANKER_S3_ENDPOINT\n\s+value: http:\/\/ranker-minio[.:]/);
  assert.match(deployment.text, /name: RANKER_S3_BUCKET\n\s+value: ranker-originals/);
  assert.match(deployment.text, /image: ghcr\.io\/noncelogic\/corpus-ranker[:@]/);
});

test("manifests target namespace corpus-ranker with CNPG, MinIO, ExternalSecrets and no ingress", () => {
  const docs = renderDocs();
  find("Namespace", "corpus-ranker");
  for (const doc of docs.filter((d) => d.kind !== "Namespace")) {
    assert.equal(doc.namespace, "corpus-ranker", `${doc.kind}/${doc.name} is not in namespace corpus-ranker`);
  }

  const db = find("Cluster", "ranker-db");
  assert.match(db.text, /^apiVersion: postgresql\.cnpg\.io\/v1$/m);
  assert.match(db.text, /^ {2}instances: 2$/m);
  assert.match(db.text, /database: ranker$/m);
  assert.match(db.text, /size: 20Gi$/m);
  assert.match(db.text, /storageClass: managed-csi-premium$/m);
  assert.match(db.text, /CREATE EXTENSION IF NOT EXISTS vector/);

  find("Deployment", "ranker-minio");
  find("PersistentVolumeClaim", "ranker-minio-data");
  find("Service", "ranker-minio");
  assert.match(find("Deployment", "ranker-minio").text, /ranker-originals/);
  find("Service", "ranker-api");

  const externalSecrets = docs.filter((d) => d.kind === "ExternalSecret");
  assert.ok(externalSecrets.length > 0, "no ExternalSecret rendered");
  for (const es of externalSecrets) {
    assert.match(es.text, /kind: ClusterSecretStore\n\s+name: openbao$/m, `${es.name} does not use the OpenBao ClusterSecretStore`);
  }

  for (const doc of docs) {
    assert.notEqual(doc.kind, "Ingress", "no public ingress allowed");
    if (doc.kind === "Service") {
      assert.doesNotMatch(doc.text, /type: (LoadBalancer|NodePort)/, `Service/${doc.name} is exposed outside the cluster`);
    }
  }
});

test("no CI workflow touches a live cluster", () => {
  const dir = resolve(repoRoot, ".github", "workflows");
  for (const file of readdirSync(dir)) {
    const text = readFileSync(resolve(dir, file), "utf8");
    assert.doesNotMatch(text, /kubectl|helm |azure\/(aks|k8s)|kubeconfig|argocd/i, `${file} touches a cluster`);
  }
});
