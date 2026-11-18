// CR-M3-D3e acceptance: deploy/openbao/check-api-keys-grant.ts reads the key
// generation hook Job's write-back grant back from OpenBao -- the policy
// corpus-ranker-api-keys and the Kubernetes auth role corpus-ranker-api-keys --
// and exits non-zero, naming each difference, unless both equal the policy and
// role the repository declares in devops/openbao/. The expected grant is the
// estate's credential_writeback rule as CR-M3-DEC-KEYGEN-GRANT applies it (Rule:
// policies/placement-defaults.yaml#estate): the one product data path, through
// the Job's own role; no metadata, no delete, no list, no other path.
//
// The first two tests run the checker against a fake `bao` on PATH serving
// fixture reads in the shapes of `bao policy read <name>` (the policy text) and
// `bao read -format=json auth/kubernetes/role/<name>` (the response envelope,
// role fields under `data`, TTLs in seconds), and the CLI's not-found messages.
// The last loads the declared files into a throwaway OpenBao dev server and
// runs the checker against its real reads. Nothing here reaches the estate.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { deployDir, repoRoot } from "./render.ts";
import { docker, startDevOpenBao } from "./openbao-dev.ts";

const NAME = "corpus-ranker-api-keys";
const ROLE_PATH = `auth/kubernetes/role/${NAME}`;
const DATA_PATH = "kv/data/corpus-ranker/api-keys";
const checker = resolve(deployDir, "openbao", "check-api-keys-grant.ts");
const policyFile = resolve(repoRoot, "devops", "openbao", "policies", `${NAME}.hcl`);
const roleFile = resolve(repoRoot, "devops", "openbao", "kubernetes-roles", `${NAME}.json`);
const declaredPolicy = readFileSync(policyFile, "utf8");
const declaredRole = JSON.parse(readFileSync(roleFile, "utf8")) as Record<string, unknown>;

/** What OpenBao 2.4 returns for the declared role: every role field, TTLs as seconds. */
function roleRead(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    request_id: "6b2c3c8e-0d6f-4b0e-9f4a-2d9a5c1e7f10",
    lease_id: "",
    lease_duration: 0,
    renewable: false,
    data: {
      alias_name_source: "serviceaccount_uid",
      audience: "",
      bound_service_account_names: ["ranker-api-keys-generate"],
      bound_service_account_namespace_selector: "",
      bound_service_account_namespaces: ["corpus-ranker"],
      token_bound_cidrs: [],
      token_explicit_max_ttl: 0,
      token_max_ttl: 300,
      token_no_default_policy: false,
      token_num_uses: 0,
      token_period: 0,
      token_policies: [NAME],
      token_strictly_bind_ip: false,
      token_ttl: 300,
      token_type: "default",
      ...overrides,
    },
    warnings: null,
  }, null, 2);
}

/** A fake `bao` on PATH: serves the given policy text and role read, or the CLI's not-found errors when absent. */
function fakeBao(t: TestContext, reads: { policy?: string; role?: string }) {
  const dir = mkdtempSync(join(tmpdir(), "fake-bao-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (reads.policy !== undefined) writeFileSync(join(dir, "policy.hcl"), reads.policy);
  if (reads.role !== undefined) writeFileSync(join(dir, "role.json"), reads.role);
  writeFileSync(join(dir, "calls"), "");
  const bao = join(dir, "bao");
  writeFileSync(bao, `#!/bin/sh
echo "$*" >> "${dir}/calls"
if [ "$1 $2 $3" = "policy read ${NAME}" ] && [ "$#" -eq 3 ]; then
  [ -f "${dir}/policy.hcl" ] && { cat "${dir}/policy.hcl"; exit 0; }
  echo "No policy named: ${NAME}" >&2; exit 2
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

test("writeback readback: passes when the read-back policy and Kubernetes auth role equal the repository's declared policy and role files", (t) => {
  // The declared role's TTLs are "5m"; OpenBao reads them back as 300 seconds.
  assert.equal(declaredRole.token_ttl, "5m");
  const bao = fakeBao(t, { policy: declaredPolicy.trimEnd(), role: roleRead() });
  const r = runChecker(bao.dir);
  assert.equal(r.code, 0, r.output);
  assert.match(r.stdout, new RegExp(`policy ${NAME}.*matches`));
  assert.match(r.stdout, new RegExp(`role ${ROLE_PATH}.*matches`));
  // It read the policy and the role, and nothing else.
  assert.deepEqual(bao.calls().trim().split("\n").sort(), [`policy read ${NAME}`, `read -format=json ${ROLE_PATH}`]);

  // The same policy written differently (no comments, other spacing and order) is the same grant.
  const terse = `path "${DATA_PATH}" {\n  capabilities = ["read", "create"]\n}\n`;
  const same = runChecker(fakeBao(t, { policy: terse, role: roleRead({ bound_service_account_names: ["ranker-api-keys-generate"] }) }).dir);
  assert.equal(same.code, 0, same.output);
});

test("writeback readback: fails naming the drift for each case: an added list, delete or metadata capability; a second or wildcard path; a different bound service account or namespace; an extra attached policy; an absent policy; an absent role", (t) => {
  const withCaps = (caps: string[]) => `path "${DATA_PATH}" {\n  capabilities = [${caps.map((c) => `"${c}"`).join(", ")}]\n}\n`;
  const cases: Array<{ name: string; policy?: string; role?: string; drift: RegExp[]; half: "policy" | "role" }> = [
    {
      name: "an added list capability",
      half: "policy",
      policy: withCaps(["create", "read", "list"]),
      role: roleRead(),
      drift: [new RegExp(`policy ${NAME}: path ${DATA_PATH}: capability "list" is not declared`)],
    },
    {
      name: "an added delete capability",
      half: "policy",
      policy: withCaps(["create", "read", "delete"]),
      role: roleRead(),
      drift: [/capability "delete" is not declared/],
    },
    {
      name: "a metadata capability",
      half: "policy",
      policy: `${declaredPolicy}\npath "kv/metadata/corpus-ranker/api-keys" {\n  capabilities = ["read", "update"]\n}\n`,
      role: roleRead(),
      drift: [new RegExp(`policy ${NAME}: path kv/metadata/corpus-ranker/api-keys is not declared`)],
    },
    {
      name: "a second path",
      half: "policy",
      policy: `${declaredPolicy}\npath "kv/data/corpus-ranker/minio" {\n  capabilities = ["read"]\n}\n`,
      role: roleRead(),
      drift: [new RegExp(`policy ${NAME}: path kv/data/corpus-ranker/minio is not declared`)],
    },
    {
      name: "a wildcard path",
      half: "policy",
      policy: `path "kv/data/corpus-ranker/*" {\n  capabilities = ["create", "read"]\n}\n`,
      role: roleRead(),
      drift: [
        new RegExp(`policy ${NAME}: path kv/data/corpus-ranker/\\* is not declared \\(wildcard\\)`),
        new RegExp(`policy ${NAME}: path ${DATA_PATH} is declared but absent`),
      ],
    },
    {
      name: "a different bound service account",
      half: "role",
      policy: declaredPolicy,
      role: roleRead({ bound_service_account_names: ["ranker-api"] }),
      drift: [
        new RegExp(`role ${ROLE_PATH}: bound_service_account_names: "ranker-api" is not declared`),
        new RegExp(`role ${ROLE_PATH}: bound_service_account_names: "ranker-api-keys-generate" is declared but absent`),
      ],
    },
    {
      name: "a wildcard bound service account",
      half: "role",
      policy: declaredPolicy,
      role: roleRead({ bound_service_account_names: ["ranker-api-keys-generate", "*"] }),
      drift: [/bound_service_account_names: "\*" is not declared/],
    },
    {
      name: "a different bound namespace",
      half: "role",
      policy: declaredPolicy,
      role: roleRead({ bound_service_account_namespaces: ["default"] }),
      drift: [
        new RegExp(`role ${ROLE_PATH}: bound_service_account_namespaces: "default" is not declared`),
        /bound_service_account_namespaces: "corpus-ranker" is declared but absent/,
      ],
    },
    {
      name: "an extra attached policy",
      half: "role",
      policy: declaredPolicy,
      role: roleRead({ token_policies: [NAME, "corpus-ranker-minio-provision"] }),
      drift: [new RegExp(`role ${ROLE_PATH}: token_policies: "corpus-ranker-minio-provision" is not declared`)],
    },
    {
      name: "an absent policy",
      half: "policy",
      role: roleRead(),
      drift: [new RegExp(`policy ${NAME}: absent`)],
    },
    {
      name: "an absent role",
      half: "role",
      policy: declaredPolicy,
      drift: [new RegExp(`role ${ROLE_PATH}: absent`)],
    },
  ];
  for (const c of cases) {
    const r = runChecker(fakeBao(t, { policy: c.policy, role: c.role }).dir);
    assert.notEqual(r.code, 0, `${c.name}: the checker passed\n${r.output}`);
    assert.notEqual(r.code, null, `${c.name}: the checker was killed\n${r.output}`);
    for (const d of c.drift) assert.match(r.stderr, d, `${c.name}: the drift is not named`);
    // Only the drifted half is reported: the other half still matches.
    const other = c.half === "policy" ? /^role /m : /^policy /m;
    assert.doesNotMatch(r.stderr, other, `${c.name}: the matching ${c.half === "policy" ? "role" : "policy"} was reported`);
    for (const line of r.stderr.trim().split("\n").slice(0, -1)) assert.match(line, new RegExp(`^${c.half} `), `${c.name}: ${line}`);
  }

  // A TTL longer than the Job's deadline is drift too, named with both values.
  const ttl = runChecker(fakeBao(t, { policy: declaredPolicy, role: roleRead({ token_ttl: 3600 }) }).dir);
  assert.equal(ttl.code, 1, ttl.output);
  assert.match(ttl.stderr, new RegExp(`role ${ROLE_PATH}: token_ttl: read 3600s, declared 300s \\(5m\\)`));

  // Several drifts at once are each named, not just the first.
  const many = runChecker(fakeBao(t, {
    policy: withCaps(["create", "read", "list", "delete"]),
    role: roleRead({ bound_service_account_namespaces: ["default"], token_policies: [NAME, "admin"] }),
  }).dir);
  assert.equal(many.code, 1, many.output);
  for (const d of [/"list" is not declared/, /"delete" is not declared/, /"default" is not declared/, /token_policies: "admin" is not declared/]) {
    assert.match(many.stderr, d);
  }
});

test("writeback readback: run against a real OpenBao holding the declared policy and role, it passes, and names drift once the role is widened", { timeout: 300_000 }, async (t) => {
  const bao = await startDevOpenBao(t);
  bao.root("auth", "enable", "kubernetes");
  docker(["cp", policyFile, `${bao.name}:/tmp/policy.hcl`]);
  docker(["cp", roleFile, `${bao.name}:/tmp/role.json`]);
  bao.root("policy", "write", NAME, "/tmp/policy.hcl");
  bao.root("write", ROLE_PATH, "@/tmp/role.json");

  // `bao` on PATH runs the server's own CLI as root, as an operator logged in to OpenBao would.
  const dir = mkdtempSync(join(tmpdir(), "dev-bao-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "bao"), `#!/bin/sh\nexec docker exec -e BAO_ADDR=http://127.0.0.1:8200 -e BAO_TOKEN=root ${bao.name} bao "$@"\n`);
  chmodSync(join(dir, "bao"), 0o755);

  const ok = runChecker(dir);
  assert.equal(ok.code, 0, ok.output);

  bao.root("write", ROLE_PATH, "bound_service_account_names=ranker-api-keys-generate,ranker-api", "token_policies=corpus-ranker-api-keys,default");
  const widened = runChecker(dir);
  assert.equal(widened.code, 1, widened.output);
  assert.match(widened.stderr, /bound_service_account_names: "ranker-api" is not declared/);
  assert.match(widened.stderr, /token_policies: "default" is not declared/);

  bao.root("policy", "delete", NAME);
  const gone = runChecker(dir);
  assert.equal(gone.code, 1, gone.output);
  assert.match(gone.stderr, new RegExp(`policy ${NAME}: absent`));
});
