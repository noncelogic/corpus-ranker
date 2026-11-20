// CR-M3-D2-ESOROLEc acceptance (Rule: policies/placement-defaults.yaml#credentials, per product,
// pull-only, custodied under the product's path; Rule: policies/placement-defaults.yaml#code_location):
// the estate External Secrets role's read grant on the ranker's ACR pull credential has a reviewed
// source in this repo, devops/openbao/policies/external-secrets-corpus-ranker-acr-pull.hcl, granting
// read on kv/data/corpus-ranker/acr-pull alone, and the ExternalSecret ranker-registry-pull reads only
// that path. Loaded alone into a throwaway OpenBao, the policy reads that path and nothing else.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderObjects, repoRoot, type K8sObject } from "./render.ts";
import { docker, policyPaths, startDevOpenBao } from "./openbao-dev.ts";

const POLICY = "external-secrets-corpus-ranker-acr-pull";
const POLICY_FILE = resolve(repoRoot, "devops", "openbao", "policies", `${POLICY}.hcl`);
const PULL_PATH = "corpus-ranker/acr-pull";

/** Every OpenBao key an ExternalSecret reads. */
const remoteKeys = (es: K8sObject): string[] => [
  ...(es.spec.data ?? []).map((d: { remoteRef?: { key?: string } }) => d.remoteRef?.key),
  ...(es.spec.dataFrom ?? []).map((d: { extract?: { key?: string } }) => d.extract?.key),
];

test("ranker-registry-pull reads only kv/data/corpus-ranker/acr-pull, the path its read policy grants", { timeout: 300_000 }, async (t) => {
  // The policy file: read on the one exact data path, nothing else.
  const hcl = readFileSync(POLICY_FILE, "utf8");
  assert.deepEqual([...policyPaths(hcl)], [[`kv/data/${PULL_PATH}`, ["read"]]], `${POLICY} grants read on kv/data/${PULL_PATH} alone`);
  assert.doesNotMatch(hcl.replace(/#.*$/gm, ""), /[*+]/, "no wildcard grants");

  // The ExternalSecret: from the estate `openbao` store, every key the policy's path.
  const matches = renderObjects().filter((o) => o.kind === "ExternalSecret" && o.metadata.name === "ranker-registry-pull");
  assert.equal(matches.length, 1, "exactly one ExternalSecret ranker-registry-pull");
  const es = matches[0]!;
  assert.deepEqual(es.spec.secretStoreRef, { kind: "ClusterSecretStore", name: "openbao" });
  const keys = remoteKeys(es);
  assert.ok(keys.length > 0, "ranker-registry-pull reads something");
  assert.deepEqual(new Set(keys), new Set([PULL_PATH]), `ranker-registry-pull reads kv/${PULL_PATH} and nothing else`);
  for (const d of es.spec.data ?? []) assert.equal(d.sourceRef, undefined, "no other source mixed in");

  // Loaded alone: a token holding the policy reads the pull credential and nothing else.
  const bao = await startDevOpenBao(t);
  docker(["cp", POLICY_FILE, `${bao.name}:/tmp/policy.hcl`]);
  bao.root("policy", "write", POLICY, "/tmp/policy.hcl");
  bao.root("kv", "put", "-mount=kv", PULL_PATH, "username=u", "password=p");
  bao.root("kv", "put", "-mount=kv", "corpus-ranker/ghcr-pull", "username=g", "password=h");
  bao.root("kv", "put", "-mount=kv", "corpus-ranker/api-keys", "joe=api-secret");
  bao.root("kv", "put", "-mount=kv", "corpus-ranker/minio", "root-user=r", "root-password=p");
  bao.root("kv", "put", "-mount=kv", "other-product/acr-pull", "username=x", "password=y");
  const token = JSON.parse(bao.root("token", "create", "-format=json", `-policy=${POLICY}`)).auth.client_token as string;

  const [code, out] = bao.as(token, "kv", "get", "-format=json", "-mount=kv", PULL_PATH);
  assert.equal(code, 0, `${POLICY} must read kv/${PULL_PATH}: ${out}`);
  assert.deepEqual(JSON.parse(out).data.data, { username: "u", password: "p" });

  const refused: string[][] = [
    ["kv", "get", "-mount=kv", "corpus-ranker/ghcr-pull"],
    ["kv", "get", "-mount=kv", "corpus-ranker/api-keys"],
    ["kv", "get", "-mount=kv", "corpus-ranker/minio"],
    ["kv", "get", "-mount=kv", "other-product/acr-pull"],
    ["kv", "get", "-mount=kv", `${PULL_PATH}-old`],
    ["kv", "list", "-mount=kv", "corpus-ranker"],
    ["kv", "put", "-mount=kv", PULL_PATH, "username=z"],
    ["kv", "patch", "-mount=kv", PULL_PATH, "username=z"],
    ["kv", "delete", "-mount=kv", PULL_PATH],
    ["kv", "metadata", "get", "-mount=kv", PULL_PATH],
    ["policy", "list"],
  ];
  for (const args of refused) {
    const [c, o] = bao.as(token, ...args);
    assert.notEqual(c, 0, `${POLICY} must not: bao ${args.join(" ")}\n${o}`);
    assert.match(o, /permission denied|403/i, `bao ${args.join(" ")} failed for another reason: ${o}`);
  }
});
