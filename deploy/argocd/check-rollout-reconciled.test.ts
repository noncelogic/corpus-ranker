// CR-M3-ROLLOUT-CHECK acceptance: deploy/argocd/check-rollout-reconciled.ts
// exits 0 only when the cluster serves the argoproj.io Rollout kind and the
// ranker's API Rollout (ranker-api in corpus-ranker) reports
// status.observedGeneration equal to metadata.generation; otherwise it exits
// non-zero naming the failed condition.
//
// The tests run the checker against a fake `kubectl` on PATH that serves
// fixture reads in the shapes of `kubectl get --raw /apis/argoproj.io/v1alpha1`
// and `kubectl get rollouts.argoproj.io ranker-api -n corpus-ranker -o json`,
// and fails any other call; nothing here reaches a cluster.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const checker = resolve(dirname(fileURLToPath(import.meta.url)), "check-rollout-reconciled.ts");

const DISCOVERY_ARGS = "get --raw /apis/argoproj.io/v1alpha1";
const ROLLOUT_ARGS = "get rollouts.argoproj.io ranker-api -n corpus-ranker -o json";

/** The APIResourceList the API server serves for argoproj.io/v1alpha1 with the given resources. */
function discovery(resources: Array<{ name: string; kind: string }>) {
  return JSON.stringify({
    kind: "APIResourceList",
    apiVersion: "v1",
    groupVersion: "argoproj.io/v1alpha1",
    resources: resources.map((r) => ({ ...r, namespaced: true, verbs: ["get", "list", "watch"] })),
  });
}
const WITH_ROLLOUTS = discovery([
  { name: "applications", kind: "Application" },
  { name: "rollouts", kind: "Rollout" },
  { name: "rollouts/status", kind: "Rollout" },
  { name: "analysistemplates", kind: "AnalysisTemplate" },
]);
const WITHOUT_ROLLOUTS = discovery([{ name: "applications", kind: "Application" }]);

function rollout(generation: number, observedGeneration?: unknown) {
  return JSON.stringify({
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Rollout",
    metadata: { name: "ranker-api", namespace: "corpus-ranker", generation },
    spec: { replicas: 1, strategy: { blueGreen: { activeService: "ranker-api", previewService: "ranker-api-preview" } } },
    status: observedGeneration === undefined ? { phase: "Healthy" } : { observedGeneration, phase: "Healthy" },
  });
}

/** A read the fake serves: JSON on stdout, or kubectl's NotFound / another error on stderr. */
type Read = { json: string } | "notfound" | "forbidden";
interface Reads {
  discovery: Read;
  rollout?: Read;
}

const NOT_FOUND: Record<string, string> = {
  discovery: "Error from server (NotFound): the server could not find the requested resource",
  rollout: 'Error from server (NotFound): rollouts.argoproj.io "ranker-api" not found',
};
const FORBIDDEN = 'Error from server (Forbidden): rollouts.argoproj.io "ranker-api" is forbidden: User "system:serviceaccount:corpus-ranker:crank-image-check" cannot get resource "rollouts"';

/** A fake `kubectl` on PATH that serves the two reads and refuses any other call with exit 64. */
function fakeKubectl(t: TestContext, reads: Reads) {
  const dir = mkdtempSync(join(tmpdir(), "fake-kubectl-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "calls"), "");
  const branch = (key: "discovery" | "rollout", read: Read | undefined) => {
    if (read === undefined) return `echo "fake kubectl: ${key} read not expected" >&2; exit 64`;
    if (read === "notfound") return `echo '${NOT_FOUND[key]}' >&2; exit 1`;
    if (read === "forbidden") return `echo '${FORBIDDEN}' >&2; exit 1`;
    writeFileSync(join(dir, `${key}.json`), read.json);
    return `cat "${dir}/${key}.json"; exit 0`;
  };
  const kubectl = join(dir, "kubectl");
  writeFileSync(kubectl, `#!/bin/sh
echo "$*" >> "${dir}/calls"
case "$*" in
  "${DISCOVERY_ARGS}") ${branch("discovery", reads.discovery)} ;;
  "${ROLLOUT_ARGS}") ${branch("rollout", reads.rollout)} ;;
esac
echo "fake kubectl: unexpected call: $*" >&2; exit 64
`);
  chmodSync(kubectl, 0o755);
  return { dir, calls: () => readFileSync(join(dir, "calls"), "utf8").trim().split("\n").filter(Boolean) };
}

function runChecker(pathPrefix: string, args: string[] = []) {
  const r = spawnSync(process.execPath, [checker, ...args], {
    encoding: "utf8",
    cwd: tmpdir(),
    env: { PATH: `${pathPrefix}:${process.env.PATH}`, HOME: process.env.HOME ?? tmpdir() },
  });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, output: `${r.stdout}${r.stderr}` };
}

test("exits 0 when the Rollout kind is served and ranker-api's observedGeneration equals its generation", (t) => {
  const kubectl = fakeKubectl(t, { discovery: { json: WITH_ROLLOUTS }, rollout: { json: rollout(4, 4) } });
  const r = runChecker(kubectl.dir);
  assert.equal(r.code, 0, r.output);
  assert.equal(r.stderr, "");
  assert.match(r.stdout, /Rollout corpus-ranker\/ranker-api/);
  assert.match(r.stdout, /observedGeneration 4 = generation 4/);
  assert.deepEqual(kubectl.calls(), [DISCOVERY_ARGS, ROLLOUT_ARGS]);
});

test("Argo Rollouts' string observedGeneration counts when it equals the generation", (t) => {
  // Older Argo Rollouts controllers write status.observedGeneration as a string.
  const kubectl = fakeKubectl(t, { discovery: { json: WITH_ROLLOUTS }, rollout: { json: rollout(7, "7") } });
  const r = runChecker(kubectl.dir);
  assert.equal(r.code, 0, r.output);
});

test("exits non-zero naming the gap when the argoproj.io/v1alpha1 group is not served", (t) => {
  const kubectl = fakeKubectl(t, { discovery: "notfound" });
  const r = runChecker(kubectl.dir);
  assert.equal(r.code, 1, r.output);
  assert.match(r.stderr, /Rollout kind \(rollouts\.argoproj\.io\) is not served/);
  assert.deepEqual(kubectl.calls(), [DISCOVERY_ARGS], "no Rollout read when the kind is not served");
});

test("exits non-zero naming the gap when argoproj.io is served without the Rollout kind", (t) => {
  const kubectl = fakeKubectl(t, { discovery: { json: WITHOUT_ROLLOUTS } });
  const r = runChecker(kubectl.dir);
  assert.equal(r.code, 1, r.output);
  assert.match(r.stderr, /Rollout kind \(rollouts\.argoproj\.io\) is not served/);
  assert.deepEqual(kubectl.calls(), [DISCOVERY_ARGS]);
});

test("exits non-zero naming the gap when the ranker-api Rollout is absent", (t) => {
  const kubectl = fakeKubectl(t, { discovery: { json: WITH_ROLLOUTS }, rollout: "notfound" });
  const r = runChecker(kubectl.dir);
  assert.equal(r.code, 1, r.output);
  assert.match(r.stderr, /Rollout corpus-ranker\/ranker-api: absent/);
});

test("exits non-zero when observedGeneration lags generation", (t) => {
  const kubectl = fakeKubectl(t, { discovery: { json: WITH_ROLLOUTS }, rollout: { json: rollout(5, 4) } });
  const r = runChecker(kubectl.dir);
  assert.equal(r.code, 1, r.output);
  assert.match(r.stderr, /Rollout corpus-ranker\/ranker-api: status\.observedGeneration 4 lags metadata\.generation 5/);
  assert.equal(r.stdout, "");
});

test("exits non-zero when the Rollout reports no observedGeneration (never reconciled)", (t) => {
  const kubectl = fakeKubectl(t, { discovery: { json: WITH_ROLLOUTS }, rollout: { json: rollout(1) } });
  const r = runChecker(kubectl.dir);
  assert.equal(r.code, 1, r.output);
  assert.match(r.stderr, /Rollout corpus-ranker\/ranker-api: no status\.observedGeneration/);
});

test("exits 2 naming the read when the Rollout read is forbidden", (t) => {
  const kubectl = fakeKubectl(t, { discovery: { json: WITH_ROLLOUTS }, rollout: "forbidden" });
  const r = runChecker(kubectl.dir);
  assert.equal(r.code, 2, r.output);
  assert.match(r.stderr, /kubectl get rollouts\.argoproj\.io ranker-api -n corpus-ranker -o json failed .*Forbidden/);
});

test("exits 2 on a usage error without reading the cluster", (t) => {
  const kubectl = fakeKubectl(t, { discovery: { json: WITH_ROLLOUTS } });
  const r = runChecker(kubectl.dir, ["--namespace", "other"]);
  assert.equal(r.code, 2, r.output);
  assert.match(r.stderr, /usage: node deploy\/argocd\/check-rollout-reconciled\.ts/);
  assert.deepEqual(kubectl.calls(), []);
});
