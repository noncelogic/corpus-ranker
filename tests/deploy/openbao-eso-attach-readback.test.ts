// CR-M3-D2g acceptance: deploy/openbao/check-eso-attach.ts reads the estate
// External Secrets role auth/kubernetes/role/eso-obs and each policy
// devops/openbao/kubernetes-roles/eso-obs.attach.json names back from OpenBao,
// and exits 0 only when the role's token_policies include every policy the
// manifest names (nothing is asserted about the role's other policies: the
// attachment is add-only) and each read-back policy's path stanzas equal its
// repository file (Rule: policies/placement-defaults.yaml#estate secrets: one
// exact path, read-only, no wildcard). Drift exits 1, naming each difference;
// failed reads exit 2.
//
// The first two tests run the checker against a fake `bao` on PATH serving
// fixture reads in the shapes of `bao policy read <name>` and
// `bao read -format=json auth/kubernetes/role/eso-obs`, and the CLI's
// not-found messages. The last loads the declared files into a throwaway
// OpenBao dev server beside an unrelated policy. Nothing here reaches the estate.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deployDir, repoRoot } from "./render.ts";
import { docker, startDevOpenBao } from "./openbao-dev.ts";

const ROLE_PATH = "auth/kubernetes/role/eso-obs";
const checker = resolve(deployDir, "openbao", "check-eso-attach.ts");
const attach = JSON.parse(readFileSync(resolve(repoRoot, "devops/openbao/kubernetes-roles/eso-obs.attach.json"), "utf8")) as {
  add_token_policies: Array<{ name: string; file: string }>;
};
const ATTACHED = attach.add_token_policies.map((p) => p.name);
const declared = new Map(attach.add_token_policies.map((p) => [p.name, readFileSync(resolve(repoRoot, p.file), "utf8")]));
const MINIO = "external-secrets-corpus-ranker-minio";
const KEYS = "external-secrets-corpus-ranker";
/** A policy the role carries that this product does not declare: the estate's GHCR pull grant, or any other. */
const OTHER = "external-secrets-ghcr-pull";

/** What OpenBao 2.4 returns for a Kubernetes auth role read. */
function roleRead(tokenPolicies: string[], overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    request_id: "1f0a6c1e-3b2d-4c8e-9a51-7e2b0d4f6a20",
    lease_id: "",
    lease_duration: 0,
    renewable: false,
    data: {
      alias_name_source: "serviceaccount_uid",
      audience: "",
      bound_service_account_names: ["external-secrets"],
      bound_service_account_namespace_selector: "",
      bound_service_account_namespaces: ["external-secrets"],
      token_bound_cidrs: [],
      token_explicit_max_ttl: 0,
      token_max_ttl: 0,
      token_no_default_policy: false,
      token_num_uses: 0,
      token_period: 0,
      token_policies: tokenPolicies,
      token_strictly_bind_ip: false,
      token_ttl: 3600,
      token_type: "default",
      ...overrides,
    },
    warnings: null,
  }, null, 2);
}

/** A fake `bao` on PATH: serves the given policies and role read, or the CLI's not-found errors when absent. */
function fakeBao(t: TestContext, reads: { policies: Record<string, string>; role?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "fake-bao-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(reads.policies)) writeFileSync(join(dir, `policy-${name}.hcl`), text);
  if (reads.role !== undefined) writeFileSync(join(dir, "role.json"), reads.role);
  writeFileSync(join(dir, "calls"), "");
  const bao = join(dir, "bao");
  writeFileSync(bao, `#!/bin/sh
echo "$*" >> "${dir}/calls"
if [ "$1 $2" = "policy read" ] && [ "$#" -eq 3 ]; then
  [ -f "${dir}/policy-$3.hcl" ] && { cat "${dir}/policy-$3.hcl"; exit 0; }
  echo "No policy named: $3" >&2; exit 2
fi
if [ "$1 $2 $3" = "read -format=json ${ROLE_PATH}" ] && [ "$#" -eq 3 ]; then
  [ -f "${dir}/role.json" ] && { cat "${dir}/role.json"; exit 0; }
  echo "No value found at ${ROLE_PATH}" >&2; exit 2
fi
echo "fake bao: unexpected call: $*" >&2; exit 64
`);
  chmodSync(bao, 0o755);
  return { dir, calls: () => readFileSync(join(dir, "calls"), "utf8") };
}

function runChecker(pathPrefix: string) {
  const r = spawnSync(process.execPath, [checker], {
    encoding: "utf8",
    cwd: tmpdir(),
    env: { PATH: `${pathPrefix}:${process.env.PATH}`, HOME: process.env.HOME ?? "/tmp" },
  });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, output: `${r.stdout}${r.stderr}` };
}

const declaredPolicies = () => Object.fromEntries(declared);

test("eso-obs attach readback: passes when the role carries every policy the attach manifest names beside its other policies, and each read-back policy equals its repository file", (t) => {
  assert.deepEqual(ATTACHED, [MINIO, KEYS]);
  const bao = fakeBao(t, { policies: declaredPolicies(), role: roleRead(["default", OTHER, ...ATTACHED]) });
  const r = runChecker(bao.dir);
  assert.equal(r.code, 0, r.output);
  for (const name of ATTACHED) {
    assert.match(r.stdout, new RegExp(`role ${ROLE_PATH}: token_policies include ${name}\\n`));
    assert.match(r.stdout, new RegExp(`policy ${name} matches devops/openbao/policies/${name}\\.hcl`));
  }
  // It read the role and the manifest's policies only: never the other policies, never a secret path.
  assert.deepEqual(bao.calls().trim().split("\n").sort(), [`policy read ${KEYS}`, `policy read ${MINIO}`, `read -format=json ${ROLE_PATH}`]);
  assert.doesNotMatch(r.output, new RegExp(OTHER));

  // The same policies written differently (no comments, other spacing), the role's policies in another order: the same.
  const terse = (path: string) => `path "${path}" { capabilities = ["read"] }`;
  const same = runChecker(fakeBao(t, {
    policies: { [MINIO]: terse("kv/data/corpus-ranker/minio"), [KEYS]: terse("kv/data/corpus-ranker/api-keys") },
    role: roleRead([KEYS, OTHER, MINIO]),
  }).dir);
  assert.equal(same.code, 0, same.output);

  // An escape HCL decodes to the declared path itself (\u0063 is "c") is the same grant.
  const escaped = runChecker(fakeBao(t, {
    policies: { ...declaredPolicies(), [MINIO]: terse("kv/data/\\u0063orpus-ranker/minio") },
    role: roleRead([OTHER, ...ATTACHED]),
  }).dir);
  assert.equal(escaped.code, 0, escaped.output);
});

test("eso-obs attach readback: fails naming the drift for each case: a manifest policy missing from the role's token_policies; an absent policy; an added capability; a second or wildcard path; an absent role", (t) => {
  const minioWith = (body: string) => `${declared.get(MINIO)}\n${body}\n`;
  const cases: Array<{ name: string; policies: Record<string, string>; role?: string; drift: RegExp[] }> = [
    {
      name: "a manifest policy missing from the role's token_policies",
      policies: declaredPolicies(),
      role: roleRead(["default", OTHER, MINIO]),
      drift: [new RegExp(`^role ${ROLE_PATH}: token_policies: "${KEYS}" is declared in devops/openbao/kubernetes-roles/eso-obs\\.attach\\.json but absent$`, "m")],
    },
    {
      name: "the role holding none of the manifest's policies (replaced or never applied)",
      policies: declaredPolicies(),
      role: roleRead([OTHER]),
      drift: [new RegExp(`token_policies: "${MINIO}" is declared .* but absent`), new RegExp(`token_policies: "${KEYS}" is declared .* but absent`)],
    },
    {
      name: "an absent policy",
      policies: { [KEYS]: declared.get(KEYS)! },
      role: roleRead([OTHER, ...ATTACHED]),
      drift: [new RegExp(`^policy ${MINIO}: absent$`, "m")],
    },
    {
      name: "an added list capability",
      policies: { ...declaredPolicies(), [KEYS]: `path "kv/data/corpus-ranker/api-keys" {\n  capabilities = ["read", "list"]\n}\n` },
      role: roleRead([OTHER, ...ATTACHED]),
      drift: [new RegExp(`^policy ${KEYS}: path kv/data/corpus-ranker/api-keys: capability "list" is not declared$`, "m")],
    },
    {
      name: "an added update capability",
      policies: { ...declaredPolicies(), [MINIO]: `path "kv/data/corpus-ranker/minio" {\n  capabilities = ["read", "update"]\n}\n` },
      role: roleRead([OTHER, ...ATTACHED]),
      drift: [new RegExp(`policy ${MINIO}: path kv/data/corpus-ranker/minio: capability "update" is not declared`)],
    },
    {
      name: "a second path",
      policies: { ...declaredPolicies(), [MINIO]: minioWith(`path "kv/data/corpus-ranker/api-keys" {\n  capabilities = ["read"]\n}`) },
      role: roleRead([OTHER, ...ATTACHED]),
      drift: [new RegExp(`^policy ${MINIO}: path kv/data/corpus-ranker/api-keys is not declared: capabilities \\["read"\\]$`, "m")],
    },
    {
      name: "a metadata path",
      policies: { ...declaredPolicies(), [MINIO]: minioWith(`path "kv/metadata/corpus-ranker/minio" {\n  capabilities = ["read", "list"]\n}`) },
      role: roleRead([OTHER, ...ATTACHED]),
      drift: [new RegExp(`policy ${MINIO}: path kv/metadata/corpus-ranker/minio is not declared`)],
    },
    {
      name: "a wildcard path",
      policies: { ...declaredPolicies(), [KEYS]: `path "kv/data/corpus-ranker/*" {\n  capabilities = ["read"]\n}\n` },
      role: roleRead([OTHER, ...ATTACHED]),
      drift: [
        new RegExp(`policy ${KEYS}: path kv/data/corpus-ranker/\\* is not declared \\(wildcard\\)`),
        new RegExp(`policy ${KEYS}: path kv/data/corpus-ranker/api-keys is declared but absent`),
      ],
    },
    {
      name: "a stanza setting other than capabilities",
      policies: { ...declaredPolicies(), [KEYS]: `path "kv/data/corpus-ranker/api-keys" {\n  capabilities = ["read"]\n  allowed_parameters = { "*" = [] }\n}\n` },
      role: roleRead([OTHER, ...ATTACHED]),
      drift: [new RegExp(`policy ${KEYS}: path kv/data/corpus-ranker/api-keys: setting "allowed_parameters" is not declared`)],
    },
    {
      // HCL decodes \r to a carriage return: OpenBao grants read on that other path, not on the declared one.
      name: "an escaped character in the path",
      policies: { ...declaredPolicies(), [MINIO]: `path "kv/data/co\\rpus-ranker/minio" { capabilities = ["read"] }\n` },
      role: roleRead([OTHER, ...ATTACHED]),
      drift: [
        new RegExp(`^policy ${MINIO}: path "kv/data/co\\\\rpus-ranker/minio" is not declared: capabilities \\["read"\\]$`, "m"),
        new RegExp(`^policy ${MINIO}: path kv/data/corpus-ranker/minio is declared but absent$`, "m"),
      ],
    },
    {
      name: "an escape the checker does not decode",
      policies: { ...declaredPolicies(), [MINIO]: `path "kv/data/\\x63orpus-ranker/minio" { capabilities = ["read"] }\n` },
      role: roleRead([OTHER, ...ATTACHED]),
      drift: [new RegExp(`^policy ${MINIO}: cannot be compared exactly: string .* holds the unsupported escape "\\\\\\\\x"$`, "m")],
    },
    {
      name: "an absent role",
      policies: declaredPolicies(),
      drift: [new RegExp(`^role ${ROLE_PATH}: absent$`, "m")],
    },
  ];
  for (const c of cases) {
    const r = runChecker(fakeBao(t, { policies: c.policies, role: c.role }).dir);
    assert.equal(r.code, 1, `${c.name}: expected exit 1\n${r.output}`);
    for (const d of c.drift) assert.match(r.stderr, d, `${c.name}: the drift is not named\n${r.stderr}`);
    // Every line but the count names the role or one policy; the role's other policies are never reported.
    const lines = r.stderr.trim().split("\n");
    assert.match(lines.at(-1)!, /difference\(s\) from devops\/openbao\/kubernetes-roles\/eso-obs\.attach\.json/);
    for (const line of lines.slice(0, -1)) assert.match(line, new RegExp(`^(role ${ROLE_PATH}|policy (${MINIO}|${KEYS})): `), `${c.name}: ${line}`);
    assert.doesNotMatch(r.stderr, new RegExp(OTHER), c.name);
  }

  // Several drifts at once are each named, not just the first.
  const many = runChecker(fakeBao(t, {
    policies: { [MINIO]: `path "kv/data/*" {\n  capabilities = ["read", "list"]\n}\n` },
    role: roleRead([OTHER, MINIO]),
  }).dir);
  assert.equal(many.code, 1, many.output);
  for (const d of [new RegExp(`token_policies: "${KEYS}" is declared`), new RegExp(`policy ${KEYS}: absent`), /path kv\/data\/\* is not declared \(wildcard\)/, /path kv\/data\/corpus-ranker\/minio is declared but absent/]) {
    assert.match(many.stderr, d);
  }

  // A read that fails for another reason (permission denied, unreachable) is exit 2, not drift.
  const dir = mkdtempSync(join(tmpdir(), "fake-bao-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "bao"), `#!/bin/sh\necho "Error reading ${ROLE_PATH}: Code: 403. Errors: * permission denied" >&2\nexit 2\n`);
  chmodSync(join(dir, "bao"), 0o755);
  const denied = runChecker(dir);
  assert.equal(denied.code, 2, denied.output);
  assert.match(denied.stderr, /permission denied/);
});

test("eso-obs attach readback: run against a real OpenBao holding eso-obs with an unrelated policy plus the attached ones, it passes, and names drift once an attached policy is widened", { timeout: 300_000 }, async (t) => {
  const bao = await startDevOpenBao(t);
  bao.root("auth", "enable", "kubernetes");
  // The role as the estate holds it before CRANK-188: an unrelated read policy of its own.
  docker(["exec", bao.name, "sh", "-c", `printf 'path "kv/data/other/thing" {\\n  capabilities = ["read"]\\n}\\n' > /tmp/other.hcl`]);
  bao.root("policy", "write", OTHER, "/tmp/other.hcl");
  bao.root("write", ROLE_PATH, "bound_service_account_names=external-secrets", "bound_service_account_namespaces=external-secrets", `token_policies=${OTHER}`);

  // `bao` on PATH runs the server's own CLI as root, as an operator logged in to OpenBao would.
  const dir = mkdtempSync(join(tmpdir(), "dev-bao-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "bao"), `#!/bin/sh\nexec docker exec -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN=root ${bao.name} bao "$@"\n`);
  chmodSync(join(dir, "bao"), 0o755);

  // Before the apply: neither policy exists nor is attached.
  const before = runChecker(dir);
  assert.equal(before.code, 1, before.output);
  for (const name of ATTACHED) {
    assert.match(before.stderr, new RegExp(`policy ${name}: absent`));
    assert.match(before.stderr, new RegExp(`token_policies: "${name}" is declared .* but absent`));
  }

  // The apply devops/openbao/README.md gives for CRANK-188: write the policies, append them to the current list.
  for (const p of attach.add_token_policies) {
    docker(["cp", resolve(repoRoot, p.file), `${bao.name}:/tmp/${p.name}.hcl`]);
    bao.root("policy", "write", p.name, `/tmp/${p.name}.hcl`);
  }
  const current = bao.root("read", "-field=token_policies", ROLE_PATH).trim().replace(/^\[|\]$/g, "").split(/\s+/).filter(Boolean);
  bao.root("write", ROLE_PATH, `token_policies=${[...current, ...ATTACHED].join(",")}`);

  const ok = runChecker(dir);
  assert.equal(ok.code, 0, ok.output);
  assert.deepEqual(
    JSON.parse(bao.root("read", "-format=json", ROLE_PATH)).data.token_policies,
    [OTHER, ...ATTACHED],
    "the unrelated policy stays attached",
  );

  // Widen an attached policy: a list capability and a wildcard path.
  docker(["exec", bao.name, "sh", "-c", `printf 'path "kv/data/corpus-ranker/minio" {\\n  capabilities = ["read", "list"]\\n}\\npath "kv/data/corpus-ranker/*" {\\n  capabilities = ["read"]\\n}\\n' > /tmp/wide.hcl`]);
  bao.root("policy", "write", MINIO, "/tmp/wide.hcl");
  const widened = runChecker(dir);
  assert.equal(widened.code, 1, widened.output);
  assert.match(widened.stderr, new RegExp(`policy ${MINIO}: path kv/data/corpus-ranker/minio: capability "list" is not declared`));
  assert.match(widened.stderr, new RegExp(`policy ${MINIO}: path kv/data/corpus-ranker/\\* is not declared \\(wildcard\\)`));
  assert.doesNotMatch(widened.stderr, new RegExp(`policy ${KEYS}[: ]`));

  // Replace instead of add: the attached policies are gone from the role.
  bao.root("write", ROLE_PATH, `token_policies=${OTHER}`);
  bao.root("policy", "write", MINIO, `/tmp/${MINIO}.hcl`);
  const replaced = runChecker(dir);
  assert.equal(replaced.code, 1, replaced.output);
  for (const name of ATTACHED) assert.match(replaced.stderr, new RegExp(`token_policies: "${name}" is declared .* but absent`));
});
