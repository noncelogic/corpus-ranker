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
/** A policy the role carries that this product does not declare (the estate's own grants, such as its ACR pull grant). */
const OTHER = "external-secrets-estate-other";

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

/**
 * A fake `bao` on PATH: serves the given policies and role read, or the CLI's not-found errors when absent.
 * `deny` lists exact invocations (arguments joined by spaces) answered with OpenBao's 403 permission denial;
 * any invocation not matched exactly fails with a distinct "unexpected call" error (exit 64).
 */
function fakeBao(t: TestContext, reads: { policies: Record<string, string>; role?: string; deny?: string[] }) {
  const dir = mkdtempSync(join(tmpdir(), "fake-bao-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(reads.policies)) writeFileSync(join(dir, `policy-${name}.hcl`), text);
  if (reads.role !== undefined) writeFileSync(join(dir, "role.json"), reads.role);
  writeFileSync(join(dir, "calls"), "");
  writeFileSync(join(dir, "deny"), (reads.deny ?? []).map((d) => `${d}\n`).join(""));
  const bao = join(dir, "bao");
  writeFileSync(bao, `#!/bin/sh
echo "$*" >> "${dir}/calls"
if [ -s "${dir}/deny" ] && printf '%s\\n' "$*" | grep -qxF -f "${dir}/deny"; then
  echo "Error reading $*: Code: 403. Errors: * permission denied" >&2; exit 2
fi
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

  // A read that fails for another reason (permission denied) is exit 2, not drift. Only the exact expected
  // invocation is denied; any other command or path would hit the fake's distinct "unexpected call" error.
  const roleDeniedBao = fakeBao(t, { policies: declaredPolicies(), role: roleRead([OTHER, ...ATTACHED]), deny: [`read -format=json ${ROLE_PATH}`] });
  const roleDenied = runChecker(roleDeniedBao.dir);
  assert.equal(roleDenied.code, 2, roleDenied.output);
  assert.match(roleDenied.stderr, new RegExp(`Error reading read -format=json ${ROLE_PATH}: Code: 403\\. Errors: \\* permission denied`));
  assert.doesNotMatch(roleDenied.output, /unexpected call/);
  assert.deepEqual(roleDeniedBao.calls().trim().split("\n"), [`read -format=json ${ROLE_PATH}`]);

  // The role reads, a manifest policy's read is denied: exit 2 naming that read, after the exact calls only.
  const policyDeniedBao = fakeBao(t, { policies: declaredPolicies(), role: roleRead([OTHER, ...ATTACHED]), deny: [`policy read ${KEYS}`] });
  const policyDenied = runChecker(policyDeniedBao.dir);
  assert.equal(policyDenied.code, 2, policyDenied.output);
  assert.match(policyDenied.stderr, new RegExp(`Error reading policy read ${KEYS}: Code: 403\\. Errors: \\* permission denied`));
  assert.doesNotMatch(policyDenied.output, /unexpected call/);
  const policyDeniedCalls = policyDeniedBao.calls().trim().split("\n");
  assert.ok(policyDeniedCalls.includes(`policy read ${KEYS}`), policyDeniedCalls.join("\n"));
  for (const call of policyDeniedCalls) {
    assert.ok([`read -format=json ${ROLE_PATH}`, `policy read ${MINIO}`, `policy read ${KEYS}`].includes(call), `unexpected call recorded: ${call}`);
  }

  // The fake's denial is exact: a different role path is not denied but rejected as an unexpected call.
  const strict = fakeBao(t, { policies: {}, deny: [`read -format=json ${ROLE_PATH}`] });
  const wrong = spawnSync(join(strict.dir, "bao"), ["read", "-format=json", "auth/kubernetes/role/eso-other"], { encoding: "utf8" });
  assert.equal(wrong.status, 64, wrong.stderr);
  assert.match(wrong.stderr, /fake bao: unexpected call: read -format=json auth\/kubernetes\/role\/eso-other/);
  assert.doesNotMatch(wrong.stderr, /permission denied/);
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

// CR-M3-D2-ACRPULL-READBACK acceptance: the ranker's ACR pull grant is declared in its own attach manifest,
// devops/openbao/kubernetes-roles/eso-obs.acr-pull.attach.json (CR-M3-D2-ACRPULL). The same checker, given
// that manifest, reads back role eso-obs on mount kubernetes and that one policy, and checks the role holds
// external-secrets-corpus-ranker-acr-pull beside its other policies and the stored text grants read on
// kv/corpus-ranker/acr-pull alone, exactly as devops/openbao/policies/external-secrets-corpus-ranker-acr-pull.hcl.
const ACR_MANIFEST = "devops/openbao/kubernetes-roles/eso-obs.acr-pull.attach.json";
const ACR = "external-secrets-corpus-ranker-acr-pull";
const ACR_FILE = `devops/openbao/policies/${ACR}.hcl`;
const acrAttach = JSON.parse(readFileSync(resolve(repoRoot, ACR_MANIFEST), "utf8")) as {
  auth_mount: string;
  role: string;
  mode: string;
  add_token_policies: Array<{ name: string; file: string }>;
};

function runCheckerWith(pathPrefix: string, args: string[], script = checker) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    cwd: tmpdir(),
    env: { PATH: `${pathPrefix}:${process.env.PATH}`, HOME: process.env.HOME ?? "/tmp" },
  });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, output: `${r.stdout}${r.stderr}` };
}

test("the readback checks the ACR pull policy attachment declared in eso-obs.acr-pull.attach.json against the role and the policy file", (t) => {
  assert.equal(acrAttach.auth_mount, "kubernetes");
  assert.equal(acrAttach.role, "eso-obs");
  assert.equal(acrAttach.mode, "add");
  assert.deepEqual(acrAttach.add_token_policies, [{ name: ACR, file: ACR_FILE }]);
  const acrText = readFileSync(resolve(repoRoot, ACR_FILE), "utf8");
  const estatePolicies = ["default", OTHER, ...ATTACHED, ACR];

  // The role holds the ACR pull policy beside its other policies, the stored text equals the file: exit 0,
  // having read the role and that one policy only (no other policy, no secret path).
  const bao = fakeBao(t, { policies: { ...declaredPolicies(), [ACR]: acrText }, role: roleRead(estatePolicies) });
  const ok = runCheckerWith(bao.dir, [ACR_MANIFEST]);
  assert.equal(ok.code, 0, ok.output);
  assert.match(ok.stdout, new RegExp(`role ${ROLE_PATH}: token_policies include ${ACR}\\n`));
  assert.match(ok.stdout, new RegExp(`policy ${ACR} matches ${ACR_FILE.replace(/\./g, "\\.")}\\n`));
  assert.deepEqual(bao.calls().trim().split("\n").sort(), [`policy read ${ACR}`, `read -format=json ${ROLE_PATH}`]);
  for (const other of [OTHER, MINIO, KEYS]) assert.doesNotMatch(ok.output, new RegExp(`${other}\\b(?!-acr-pull)`));

  // The same policy written tersely: the same grant.
  const terse = runCheckerWith(fakeBao(t, {
    policies: { [ACR]: `path "kv/data/corpus-ranker/acr-pull" { capabilities = ["read"] }` },
    role: roleRead([OTHER, ACR]),
  }).dir, [ACR_MANIFEST]);
  assert.equal(terse.code, 0, terse.output);

  // Drift is named against the ACR pull manifest.
  const cases: Array<{ name: string; policies: Record<string, string>; role?: string; drift: RegExp }> = [
    { name: "detached", policies: { [ACR]: acrText }, role: roleRead(["default", OTHER, ...ATTACHED]),
      drift: new RegExp(`^role ${ROLE_PATH}: token_policies: "${ACR}" is declared in devops/openbao/kubernetes-roles/eso-obs\\.acr-pull\\.attach\\.json but absent$`, "m") },
    { name: "absent policy", policies: {}, role: roleRead([OTHER, ACR]), drift: new RegExp(`^policy ${ACR}: absent$`, "m") },
    { name: "list added", policies: { [ACR]: `path "kv/data/corpus-ranker/acr-pull" {\n  capabilities = ["read", "list"]\n}\n` }, role: roleRead([OTHER, ACR]),
      drift: new RegExp(`^policy ${ACR}: path kv/data/corpus-ranker/acr-pull: capability "list" is not declared$`, "m") },
    { name: "another path", policies: { [ACR]: `${acrText}\npath "kv/data/corpus-ranker/api-keys" {\n  capabilities = ["read"]\n}\n` }, role: roleRead([OTHER, ACR]),
      drift: new RegExp(`^policy ${ACR}: path kv/data/corpus-ranker/api-keys is not declared`, "m") },
    { name: "wildcard", policies: { [ACR]: `path "kv/data/corpus-ranker/*" {\n  capabilities = ["read"]\n}\n` }, role: roleRead([OTHER, ACR]),
      drift: new RegExp(`policy ${ACR}: path kv/data/corpus-ranker/\\* is not declared \\(wildcard\\)`) },
    { name: "absent role", policies: { [ACR]: acrText }, drift: new RegExp(`^role ${ROLE_PATH}: absent$`, "m") },
  ];
  for (const c of cases) {
    const r = runCheckerWith(fakeBao(t, { policies: c.policies, role: c.role }).dir, [ACR_MANIFEST]);
    assert.equal(r.code, 1, `${c.name}: expected exit 1\n${r.output}`);
    assert.match(r.stderr, c.drift, `${c.name}: the drift is not named\n${r.stderr}`);
    assert.match(r.stderr.trim().split("\n").at(-1)!, /difference\(s\) from devops\/openbao\/kubernetes-roles\/eso-obs\.acr-pull\.attach\.json$/);
    assert.doesNotMatch(r.stderr, new RegExp(OTHER), c.name);
  }

  // Only an eso-obs attach manifest in devops/openbao/kubernetes-roles/ is accepted, and one at most: anything
  // else is a usage error (exit 2) before OpenBao is read.
  for (const args of [["devops/openbao/kubernetes-roles/corpus-ranker-api-keys.json"], ["/etc/passwd"], ["devops/openbao/kubernetes-roles/../../../package.json"], [ACR_MANIFEST, ACR_MANIFEST]]) {
    const refused = fakeBao(t, { policies: { [ACR]: acrText }, role: roleRead([OTHER, ACR]) });
    const r = runCheckerWith(refused.dir, args);
    assert.equal(r.code, 2, `${args.join(" ")}: ${r.output}`);
    assert.match(r.stderr, /usage: node deploy\/openbao\/check-eso-attach\.ts \[devops\/openbao\/kubernetes-roles\/eso-obs\[\.<name>\]\.attach\.json\]/);
    assert.equal(refused.calls(), "", "nothing was read");
  }
});

test("eso-obs ACR pull attach readback: applied add-only from main to a real OpenBao whose eso-obs already holds the ACR pull policy, nothing is written and the readback passes", { timeout: 300_000 }, async (t) => {
  const bao = await startDevOpenBao(t);
  bao.root("auth", "enable", "kubernetes");
  // The role as the estate holds it (readback 2026-11-20): its own policy, the ranker's two, and the ACR pull grant.
  docker(["exec", bao.name, "sh", "-c", `printf 'path "kv/data/other/thing" {\\n  capabilities = ["read"]\\n}\\n' > /tmp/other.hcl`]);
  bao.root("policy", "write", OTHER, "/tmp/other.hcl");
  docker(["cp", resolve(repoRoot, ACR_FILE), `${bao.name}:/tmp/${ACR}.hcl`]);
  bao.root("policy", "write", ACR, `/tmp/${ACR}.hcl`);
  const estate = [OTHER, ACR];
  bao.root("write", ROLE_PATH, "bound_service_account_names=external-secrets", "bound_service_account_namespaces=external-secrets", `token_policies=${estate.join(",")}`, "token_ttl=20m");
  const roleBefore = JSON.parse(bao.root("read", "-format=json", ROLE_PATH)).data;

  const dir = mkdtempSync(join(tmpdir(), "dev-bao-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "bao"), `#!/bin/sh\nexec docker exec -i -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN=root ${bao.name} bao "$@"\n`);
  chmodSync(join(dir, "bao"), 0o755);

  // The DevOps apply from main with the ACR pull manifest: add-only, the policy already stored byte-identical
  // and attached, so nothing is written.
  const applied = runCheckerWith(dir, [ACR_MANIFEST], resolve(deployDir, "openbao", "attach-eso.ts"));
  assert.equal(applied.code, 0, applied.output);
  const record = JSON.parse(applied.stdout.trim().split("\n").at(-1)!);
  assert.deepEqual(record.appended, []);
  assert.deepEqual(record.policies_written, []);
  assert.deepEqual(record.token_policies_after, estate);
  assert.equal(record.settings_preserved, true);
  assert.deepEqual(Object.keys(record.policy_sha256), [ACR]);
  assert.deepEqual(JSON.parse(bao.root("read", "-format=json", ROLE_PATH)).data, roleBefore, "the role is untouched");

  const ok = runCheckerWith(dir, [ACR_MANIFEST]);
  assert.equal(ok.code, 0, ok.output);
  assert.match(ok.stdout, new RegExp(`token_policies include ${ACR}`));
  assert.match(ok.stdout, new RegExp(`policy ${ACR} matches ${ACR_FILE.replace(/\./g, "\\.")}`));

  // Detached by a replace: the readback names it.
  bao.root("write", ROLE_PATH, `token_policies=${OTHER}`);
  const detached = runCheckerWith(dir, [ACR_MANIFEST]);
  assert.equal(detached.code, 1, detached.output);
  assert.match(detached.stderr, new RegExp(`token_policies: "${ACR}" is declared in ${ACR_MANIFEST.replace(/\./g, "\\.")} but absent`));

  // The apply re-attaches it after the role's own policy, add-only; the readback passes again.
  const healed = runCheckerWith(dir, [ACR_MANIFEST], resolve(deployDir, "openbao", "attach-eso.ts"));
  assert.equal(healed.code, 0, healed.output);
  assert.deepEqual(JSON.parse(bao.root("read", "-format=json", ROLE_PATH)).data.token_policies, [OTHER, ACR]);
  assert.equal(runCheckerWith(dir, [ACR_MANIFEST]).code, 0);
});
