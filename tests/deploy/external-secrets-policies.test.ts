// CR-M3-D2e acceptance (CRANK-187 of PR #49; Rule: policies/placement-defaults.yaml#credentials;
// Rule: policies/placement-defaults.yaml#estate secrets and grants_from_spec): the estate apply
// deploy/openbao/attach-eso.ts, run from main, writes both per-custody-path External Secrets read
// policies and attaches them to the estate External Secrets role (eso-obs on mount kubernetes, as
// CR-M3-D2c declares it in devops/openbao/kubernetes-roles/eso-obs.attach.json), and each attached
// policy grants read on exactly one kv/corpus-ranker/<purpose> path: no wildcard, no list, no write,
// no metadata, and the two policies' paths are distinct and together are the custody paths the
// ranker's `openbao` ExternalSecrets read (the ACR pull path is granted by the role's own
// attach manifest, devops/openbao/kubernetes-roles/eso-obs.acr-pull.attach.json).
//
// The apply and its readback (deploy/openbao/check-eso-attach.ts) hold that rule themselves: a
// manifest policy file granting more than one exact kv/corpus-ranker/<purpose> read is refused with
// exit 2 before anything is written, so a widened file on main can never reach the estate role.
//
// Runs against a throwaway OpenBao holding the role as the estate does before the apply; nothing
// here reaches the estate.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { renderObjects, repoRoot, type K8sObject } from "./render.ts";
import { docker, policyPaths, startDevOpenBao, type DevOpenBao } from "./openbao-dev.ts";

const ROLE = "auth/kubernetes/role/eso-obs";
const PRIOR = "eso-sync";
/** Each attached policy and the one custody path it grants, as the attach manifest declares them. */
const ATTACHED = [
  { name: "external-secrets-corpus-ranker-minio", path: "corpus-ranker/minio" },
  { name: "external-secrets-corpus-ranker", path: "corpus-ranker/api-keys" },
] as const;
/** The ACR pull path, granted through devops/openbao/kubernetes-roles/eso-obs.acr-pull.attach.json, not eso-obs.attach.json. */
const ACR_PULL = "corpus-ranker/acr-pull";

/** Every OpenBao key the rendered ExternalSecrets on ClusterSecretStore `openbao` read. */
function storeKeys(): Set<string> {
  return new Set(
    renderObjects()
      .filter((o: K8sObject) => o.kind === "ExternalSecret" && o.spec?.secretStoreRef?.name === "openbao")
      .flatMap((es: K8sObject) => [
        ...(es.spec.data ?? []).map((d: { remoteRef?: { key?: string } }) => d.remoteRef?.key),
        ...(es.spec.dataFrom ?? []).map((d: { extract?: { key?: string } }) => d.extract?.key),
      ]),
  );
}

/** Copy the apply scripts and the OpenBao config to a scratch repository root, so a policy file can be altered there. */
function scratchRepo(t: TestContext): string {
  const root = mkdtempSync(join(tmpdir(), "cr-eso-repo-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(resolve(repoRoot, "deploy", "openbao"), join(root, "deploy", "openbao"), { recursive: true });
  cpSync(resolve(repoRoot, "devops", "openbao"), join(root, "devops", "openbao"), { recursive: true });
  writeFileSync(join(root, "package.json"), '{ "type": "module" }\n');
  return root;
}

/** Run a deploy/openbao script from `root` with a `bao` on PATH that is the throwaway server's CLI as root. */
function runner(t: TestContext, bao: DevOpenBao) {
  const bin = mkdtempSync(join(tmpdir(), "cr-eso-bin-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(join(bin, "bao"), `#!/bin/sh\nexec docker exec -i -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN=root ${bao.name} bao "$@"\n`);
  chmodSync(join(bin, "bao"), 0o755);
  return (root: string, script: string) => {
    const r = spawnSync(process.execPath, [join(root, "deploy", "openbao", script)], {
      encoding: "utf8",
      cwd: tmpdir(),
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME ?? "/tmp" },
    });
    if (r.error) throw r.error;
    return { code: r.status, stdout: r.stdout, output: `${r.stdout}${r.stderr}` };
  };
}

test("the estate External Secrets role attaches both per-custody-path read policies and each grants read on exactly one kv/corpus-ranker path", { timeout: 300_000 }, async (t) => {
  // The custody paths follow from the deployment spec: the attached policies cover exactly the
  // openbao ExternalSecrets' paths other than the ACR pull path its own manifest grants.
  const keys = storeKeys();
  assert.deepEqual(
    new Set([...keys].filter((k) => k !== ACR_PULL)),
    new Set(ATTACHED.map((a) => a.path)),
    "the attached policies' paths are the custody paths the ranker's openbao ExternalSecrets read",
  );
  const manifest = JSON.parse(readFileSync(resolve(repoRoot, "devops/openbao/kubernetes-roles/eso-obs.attach.json"), "utf8"));
  assert.deepEqual(
    manifest.add_token_policies.map((p: { name: string }) => p.name),
    ATTACHED.map((a) => a.name),
    "the manifest attaches both per-custody-path policies",
  );

  const bao = await startDevOpenBao(t);
  bao.root("auth", "enable", "kubernetes");
  docker(["exec", bao.name, "sh", "-c", `printf 'path "kv/data/estate/sync" {\\n  capabilities = ["read"]\\n}\\n' > /tmp/prior.hcl`]);
  bao.root("policy", "write", PRIOR, "/tmp/prior.hcl");
  bao.root("kv", "put", "-mount=kv", "corpus-ranker/api-keys", "joe=api-secret");
  bao.root("kv", "put", "-mount=kv", "corpus-ranker/minio", "root-user=r", "root-password=p", "service-user=s", "service-password=q");
  bao.root("kv", "put", "-mount=kv", ACR_PULL, "username=u", "password=p");
  bao.root("kv", "put", "-mount=kv", "other-product/api-keys", "x=y");
  bao.root(
    "write", ROLE,
    "bound_service_account_names=external-secrets", "bound_service_account_namespaces=external-secrets",
    `token_policies=${PRIOR}`, "token_ttl=20m", "token_max_ttl=1h", "audience=openbao",
  );
  const roleData = (): Record<string, unknown> => JSON.parse(bao.root("read", "-format=json", ROLE)).data;
  const policyText = (name: string): string | undefined => {
    const [code, out] = bao.as("root", "read", "-format=json", `sys/policy/${name}`);
    return code === 0 ? JSON.parse(out).data.rules : undefined;
  };
  const run = runner(t, bao);

  // A policy file on the branch that breaks the rule is refused before anything is written: a
  // wildcard, a list, a write, a second path, a path outside kv/corpus-ranker/<purpose>, and the
  // same custody path granted by both policies.
  const minioFile = join("devops", "openbao", "policies", `${ATTACHED[0].name}.hcl`);
  const widened: Array<[string, string]> = [
    ["wildcard", `path "kv/data/corpus-ranker/*" {\n  capabilities = ["read"]\n}\n`],
    ["list", `path "kv/data/corpus-ranker/minio" {\n  capabilities = ["read", "list"]\n}\n`],
    ["write", `path "kv/data/corpus-ranker/minio" {\n  capabilities = ["read", "update"]\n}\n`],
    ["second path", `path "kv/data/corpus-ranker/minio" {\n  capabilities = ["read"]\n}\npath "kv/data/corpus-ranker/acr-pull" {\n  capabilities = ["read"]\n}\n`],
    ["metadata", `path "kv/metadata/corpus-ranker/minio" {\n  capabilities = ["read"]\n}\n`],
    ["another product", `path "kv/data/other-product/api-keys" {\n  capabilities = ["read"]\n}\n`],
    ["nested path", `path "kv/data/corpus-ranker/minio/root" {\n  capabilities = ["read"]\n}\n`],
    ["shared path", `path "kv/data/corpus-ranker/api-keys" {\n  capabilities = ["read"]\n}\n`],
  ];
  for (const [what, hcl] of widened) {
    const root = scratchRepo(t);
    writeFileSync(join(root, minioFile), hcl);
    for (const script of ["attach-eso.ts", "check-eso-attach.ts"]) {
      const r = run(root, script);
      assert.equal(r.code, 2, `${script} must refuse a policy file with a ${what} grant:\n${r.output}`);
      assert.match(r.output, new RegExp(`${ATTACHED[0].name}`), `${script} names the refused policy (${what}):\n${r.output}`);
    }
    assert.deepEqual(roleData().token_policies, [PRIOR], `a refused apply (${what}) attached nothing`);
    for (const { name } of ATTACHED) assert.equal(policyText(name), undefined, `a refused apply (${what}) wrote no policy`);
  }

  // Applied from main: both policies written byte-identical and attached after the role's own.
  const applied = run(repoRoot, "attach-eso.ts");
  assert.equal(applied.code, 0, applied.output);
  const role = roleData();
  assert.deepEqual(role.token_policies, [PRIOR, ...ATTACHED.map((a) => a.name)]);
  const record = JSON.parse(applied.stdout.trim().split("\n").at(-1)!);
  assert.deepEqual(record.appended, ATTACHED.map((a) => a.name));
  assert.equal(record.settings_preserved, true);

  for (const { name, path } of ATTACHED) {
    const file = readFileSync(resolve(repoRoot, "devops", "openbao", "policies", `${name}.hcl`), "utf8");
    assert.equal(policyText(name), file, `${name} is byte-identical to main`);
    assert.deepEqual([...policyPaths(policyText(name)!)], [[`kv/data/${path}`, ["read"]]], `${name} grants read on kv/${path} alone`);

    // A token holding this policy alone reads its one path and nothing else.
    const token = JSON.parse(bao.root("token", "create", "-format=json", `-policy=${name}`)).auth.client_token as string;
    const [code, out] = bao.as(token, "kv", "get", "-mount=kv", path);
    assert.equal(code, 0, `${name} must read kv/${path}: ${out}`);
    const refused: string[][] = [
      ...ATTACHED.filter((a) => a.path !== path).map((a) => ["kv", "get", "-mount=kv", a.path]),
      ["kv", "get", "-mount=kv", ACR_PULL],
      ["kv", "get", "-mount=kv", "other-product/api-keys"],
      ["kv", "list", "-mount=kv", "corpus-ranker"],
      ["kv", "put", "-mount=kv", path, "x=y"],
      ["kv", "patch", "-mount=kv", path, "x=y"],
      ["kv", "delete", "-mount=kv", path],
      ["kv", "metadata", "get", "-mount=kv", path],
    ];
    for (const args of refused) {
      const [c, o] = bao.as(token, ...args);
      assert.notEqual(c, 0, `${name} must not: bao ${args.join(" ")}\n${o}`);
      assert.match(o, /permission denied|403/i, `bao ${args.join(" ")} failed for another reason: ${o}`);
    }
  }

  // The role's token resolves both custody paths, so both ranker ExternalSecrets resolve.
  const token = JSON.parse(bao.root("token", "create", "-format=json", ...(role.token_policies as string[]).map((p) => `-policy=${p}`))).auth.client_token as string;
  for (const { path } of ATTACHED) assert.equal(bao.as(token, "kv", "get", "-mount=kv", path)[0], 0, `the role reads kv/${path}`);

  // The readback agrees with main, and a second apply writes nothing.
  const checked = run(repoRoot, "check-eso-attach.ts");
  assert.equal(checked.code, 0, checked.output);
  const again = run(repoRoot, "attach-eso.ts");
  assert.equal(again.code, 0, again.output);
  assert.deepEqual(JSON.parse(again.stdout.trim().split("\n").at(-1)!).appended, []);
  assert.deepEqual(roleData(), role);
});
