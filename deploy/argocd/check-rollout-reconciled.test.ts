// CR-M3-ROLLOUT-CHECK acceptance: deploy/argocd/check-rollout-reconciled.ts
// exits 0 only when the cluster serves the argoproj.io Rollout kind and the
// Rollout corpus-ranker/ranker-api reports status.observedGeneration equal to
// metadata.generation (the Argo Rollouts controller reconciled it). Otherwise
// it exits non-zero naming the failed condition.
//
// The tests run the checker against a fake `kubectl` on PATH serving fixture
// reads in the shapes of `kubectl get --raw /apis/argoproj.io/v1alpha1` and
// `kubectl get rollouts.argoproj.io ranker-api -n corpus-ranker -o json`; any
// other call fails. Nothing here reaches the estate.
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

/** The argoproj.io/v1alpha1 APIResourceList; `withRollout` false leaves only Argo CD's kinds. */
function discovery(withRollout: boolean) {
  const resources = [
    { name: "applications", singularName: "application", namespaced: true, kind: "Application", verbs: ["get", "list"] },
    { name: "appprojects", singularName: "appproject", namespaced: true, kind: "AppProject", verbs: ["get", "list"] },
  ];
  if (withRollout) {
    resources.push(
      { name: "rollouts", singularName: "rollout", namespaced: true, kind: "Rollout", verbs: ["get", "list"] },
      { name: "rollouts/status", singularName: "", namespaced: true, kind: "Rollout", verbs: ["get", "patch"] },
    );
  }
  return JSON.stringify({ kind: "APIResourceList", apiVersion: "v1", groupVersion: "argoproj.io/v1alpha1", resources });
}

function rollout(generation: number, status: Record<string, unknown> | undefined) {
  return JSON.stringify({
    apiVersion: "argoproj.io/v1alpha1",
    kind: "Rollout",
    metadata: { name: "ranker-api", namespace: "corpus-ranker", generation },
    spec: { replicas: 1 },
    ...(status === undefined ? {} : { status }),
  });
}

interface Reads {
  /** The discovery document, or undefined when the group version is not served (404). */
  discovery?: string;
  /** The Rollout, or undefined when absent (NotFound). */
  rollout?: string;
  /** Make the Rollout read fail as forbidden. */
  rolloutForbidden?: boolean;
}

/** A fake `kubectl` on PATH: serves the two reads, kubectl's NotFound errors, and fails any other call. */
function fakeKubectl(t: TestContext, reads: Reads) {
  const dir = mkdtempSync(join(tmpdir(), "fake-kubectl-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (reads.discovery !== undefined) writeFileSync(join(dir, "discovery.json"), reads.discovery);
  if (reads.rollout !== undefined) writeFileSync(join(dir, "rollout.json"), reads.rollout);
  writeFileSync(join(dir, "calls"), "");
  const forbidden = reads.rolloutForbidden
    ? `echo 'Error from server (Forbidden): rollouts.argoproj.io "ranker-api" is forbidden: User "system:serviceaccount:corpus-ranker:crank-image-check" cannot get resource "rollouts"' >&2; exit 1`
    : "";
  const kubectl = join(dir, "kubectl");
  writeFileSync(kubectl, `#!/bin/sh
echo "$*" >> "${dir}/calls"
case "$*" in
  "${DISCOVERY_ARGS}")
    [ -f "${dir}/discovery.json" ] && { cat "${dir}/discovery.json"; exit 0; }
    echo 'Error from server (NotFound): the server could not find the requested resource' >&2; exit 1 ;;
  "${ROLLOUT_ARGS}")
    ${forbidden}
    [ -f "${dir}/rollout.json" ] && { cat "${dir}/rollout.json"; exit 0; }
    echo 'Error from server (NotFound): rollouts.argoproj.io "ranker-api" not found' >&2; exit 1 ;;
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
  const kubectl = fakeKubectl(t, { discovery: discovery(true), rollout: rollout(4, { observedGeneration: "4", phase: "Healthy" }) });
  const r = runChecker(kubectl.dir);
  assert.equal(r.code, 0, r.output);
  assert.equal(r.stderr, "");
  assert.match(r.stdout, /Rollout corpus-ranker\/ranker-api/);
  assert.match(r.stdout, /observedGeneration 4 equals generation 4/);
  assert.deepEqual(kubectl.calls(), [DISCOVERY_ARGS, ROLLOUT_ARGS]);
});

test("exits 0 when the controller reports observedGeneration as a number", (t) => {
  const kubectl = fakeKubectl(t, { discovery: discovery(true), rollout: rollout(2, { observedGeneration: 2 }) });
  const r = runChecker(kubectl.dir);
  assert.equal(r.code, 0, r.output);
});

test("exits 1 naming the gap when the argoproj.io group version is not served", (t) => {
  const kubectl = fakeKubectl(t, { rollout: rollout(4, { observedGeneration: "4" }) });
  const r = runChecker(kubectl.dir);
  assert.equal(r.code, 1, r.output);
  assert.match(r.stderr, /Rollout kind is not served/);
  assert.match(r.stderr, /argoproj\.io\/v1alpha1/);
  assert.equal(r.stdout, "");
  // Without the kind there is no Rollout to read.
  assert.deepEqual(kubectl.calls(), [DISCOVERY_ARGS]);
});

test("exits 1 naming the gap when argoproj.io is served (Argo CD) but has no Rollout kind", (t) => {
  const kubectl = fakeKubectl(t, { discovery: discovery(false), rollout: rollout(4, { observedGeneration: "4" }) });
  const r = runChecker(kubectl.dir);
  assert.equal(r.code, 1, r.output);
  assert.match(r.stderr, /Rollout kind is not served/);
  assert.deepEqual(kubectl.calls(), [DISCOVERY_ARGS]);
});

test("exits 1 naming the gap when the Rollout ranker-api is absent", (t) => {
  const kubectl = fakeKubectl(t, { discovery: discovery(true) });
  const r = runChecker(kubectl.dir);
  assert.equal(r.code, 1, r.output);
  assert.match(r.stderr, /Rollout corpus-ranker\/ranker-api: absent/);
  assert.deepEqual(kubectl.calls(), [DISCOVERY_ARGS, ROLLOUT_ARGS]);
});

test("exits 1 when observedGeneration lags generation", (t) => {
  const kubectl = fakeKubectl(t, { discovery: discovery(true), rollout: rollout(5, { observedGeneration: "4" }) });
  const r = runChecker(kubectl.dir);
  assert.equal(r.code, 1, r.output);
  assert.match(r.stderr, /Rollout corpus-ranker\/ranker-api: status\.observedGeneration 4 lags metadata\.generation 5/);
  assert.equal(r.stdout, "");
});

test("exits 1 when the Rollout has no status yet (never reconciled)", (t) => {
  const kubectl = fakeKubectl(t, { discovery: discovery(true), rollout: rollout(1, undefined) });
  const r = runChecker(kubectl.dir);
  assert.equal(r.code, 1, r.output);
  assert.match(r.stderr, /Rollout corpus-ranker\/ranker-api: reports no status\.observedGeneration/);
});

test("exits 2 naming the read when kubectl is refused", (t) => {
  const kubectl = fakeKubectl(t, { discovery: discovery(true), rolloutForbidden: true });
  const r = runChecker(kubectl.dir);
  assert.equal(r.code, 2, r.output);
  assert.match(r.stderr, /Forbidden/);
});

test("exits 2 on usage error without reading the cluster", (t) => {
  const kubectl = fakeKubectl(t, { discovery: discovery(true) });
  const r = runChecker(kubectl.dir, ["extra"]);
  assert.equal(r.code, 2, r.output);
  assert.match(r.stderr, /usage/);
  assert.deepEqual(kubectl.calls(), []);
});
