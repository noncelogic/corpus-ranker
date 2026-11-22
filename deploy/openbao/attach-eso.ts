#!/usr/bin/env node
// Attach the ranker's External Secrets read policies to the estate role the
// `openbao` ClusterSecretStore logs in with, add-only, and read the result
// back (CRANK-188; Rule: policies/placement-defaults.yaml#estate secrets):
//
//   node deploy/openbao/attach-eso.ts [devops/openbao/kubernetes-roles/eso-obs[.<name>].attach.json]
//
// With no argument it applies devops/openbao/kubernetes-roles/eso-obs.attach.json;
// given another eso-obs attach manifest beside it (eso-obs.acr-pull.attach.json,
// the ACR pull grant), it applies that one the same way. Any other argument is
// a usage error.
//
// The manifest names the auth mount, the role (eso-obs on mount kubernetes) and the policies to add, each with
// its file in devops/openbao/policies/. Each file must itself grant read on
// exactly one kv/corpus-ranker/<purpose> path, a different one per policy, and
// nothing else (no wildcard, list, write or metadata); a file that does not is
// refused with exit 2 before OpenBao is read or written. In order, this script:
//
//   1. snapshots the live role (`bao read -format=json auth/<mount>/role/<role>`).
//      An absent role is never created: exit 2, nothing written;
//   2. writes each manifest policy whose stored text
//      (`bao read -format=json sys/policy/<name>`) is not byte-identical to its
//      file (`bao policy write <name> -`, the file's bytes on stdin), and reads each back to check
//      the stored bytes equal the file. Only the manifest's policies are ever
//      written; the role's other policies are not read or touched;
//   3. appends only the manifest policies missing from the role's
//      token_policies, after the existing ones in their order
//      (`bao write auth/<mount>/role/<role> token_policies=<existing>,<missing>`).
//      A write naming only token_policies leaves every other role setting as
//      it is; when nothing is missing the role is not written at all;
//   4. reads the role back and checks token_policies are exactly the snapshot's
//      followed by the appended names, and every other setting equals the
//      snapshot.
//
// The last stdout line is one JSON record for the estate log (meta-harness
// devops/openbao/README.md): the role, token_policies before and after, the
// appended names, the policies rewritten, the sha256 of each policy file, and
// settings_preserved. It reads names, role settings and policy text only,
// never a secret.
//
// Run estate-side, logged in to OpenBao (`bao login`) with rights to read and
// write policies and the role. Exit 0: applied and read back as declared.
// Exit 1: the readback differs (each difference on stderr, one per line).
// Exit 2: a read or write failed (unreachable, permission denied), the role
// is absent, the manifest or a policy file it names is unreadable or breaks
// the one-exact-path read-only rule, or a usage error.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { resolve } from "node:path";
import { bao, quote, ReadError } from "./policy-grants.ts";
import { MANIFEST_ARG, manifestArg, readManifest, repoRoot } from "./eso-attach-manifest.ts";

type RoleData = Record<string, unknown>;

/** The role's settings, or undefined when it does not exist. */
function readRole(rolePath: string): RoleData | undefined {
  const text = bao(["read", "-format=json", rolePath], /no value found at/i);
  if (text === undefined) return undefined;
  let data: unknown;
  try {
    data = (JSON.parse(text) as { data?: unknown }).data;
  } catch {
    throw new ReadError(`bao read ${rolePath} returned something other than JSON`);
  }
  if (typeof data !== "object" || data === null) throw new ReadError(`bao read ${rolePath} returned no role data`);
  const policies = (data as RoleData).token_policies;
  if (!Array.isArray(policies) || !policies.every((p) => typeof p === "string")) throw new ReadError(`bao read ${rolePath} returned no token_policies list`);
  return data as RoleData;
}

/** The stored text of a policy, or undefined when it does not exist. */
function readPolicyText(name: string): string | undefined {
  const text = bao(["read", "-format=json", `sys/policy/${name}`], /no value found at/i);
  if (text === undefined) return undefined;
  try {
    const rules = (JSON.parse(text) as { data?: { rules?: unknown } }).data?.rules;
    if (typeof rules === "string") return rules;
  } catch {
    // fall through
  }
  throw new ReadError(`bao read sys/policy/${name} returned no policy text`);
}

/**
 * Settings other than the policy list. `policies` is OpenBao's legacy alias of token_policies: it is set aside
 * when it only mirrors token_policies, and otherwise kept so a change to it is caught.
 */
function otherSettings(data: RoleData): RoleData {
  const { token_policies, policies, ...rest } = data;
  return policies === undefined || isDeepStrictEqual(policies, token_policies) ? rest : { ...rest, policies };
}

function main(argv: string[]): number {
  const manifest = manifestArg(argv);
  if (manifest === undefined) {
    process.stderr.write(`usage: node deploy/openbao/attach-eso.ts ${MANIFEST_ARG}\n`);
    return 2;
  }
  const drift: string[] = [];
  let record: Record<string, unknown>;
  try {
    const attach = readManifest(manifest);
    const rolePath = `auth/${attach.authMount}/role/${attach.role}`;
    const at = `role ${rolePath}`;

    // 1. Snapshot.
    const before = readRole(rolePath);
    if (before === undefined) throw new ReadError(`${at}: absent; it is the estate's, never created here`);
    const policiesBefore = before.token_policies as string[];
    process.stdout.write(`${at}: snapshot token_policies ${quote(policiesBefore)}\n`);

    // 2. Policies, byte-identical to their files.
    const rewritten: string[] = [];
    const sha256: Record<string, string> = {};
    for (const { name, file } of attach.policies) {
      let declared: string;
      try {
        declared = readFileSync(resolve(repoRoot, file), "utf8");
      } catch (err) {
        throw new ReadError(`cannot read ${file}: ${(err as Error).message}`);
      }
      sha256[name] = createHash("sha256").update(declared).digest("hex");
      if (readPolicyText(name) !== declared) {
        if (bao(["policy", "write", name, "-"], /^$/, declared) === undefined) throw new ReadError(`bao policy write ${name} failed`);
        rewritten.push(name);
        process.stdout.write(`policy ${name}: written from ${file}\n`);
      }
      const stored = readPolicyText(name);
      if (stored === undefined) drift.push(`policy ${name}: absent after write`);
      else if (stored !== declared) drift.push(`policy ${name}: stored text differs from ${file}`);
      else process.stdout.write(`policy ${name}: byte-identical to ${file} (sha256 ${sha256[name]})\n`);
    }

    // 3. Append only what is missing.
    const missing = attach.policies.map((p) => p.name).filter((n) => !policiesBefore.includes(n));
    const expected = [...policiesBefore, ...missing];
    if (missing.length > 0) {
      if (bao(["write", rolePath, `token_policies=${expected.join(",")}`], /^$/) === undefined) throw new ReadError(`bao write ${rolePath} failed`);
      process.stdout.write(`${at}: appended ${quote(missing)}\n`);
    } else {
      process.stdout.write(`${at}: already carries every manifest policy; not written\n`);
    }

    // 4. Read the role back.
    const after = readRole(rolePath);
    if (after === undefined) throw new ReadError(`${at}: absent after write`);
    const policiesAfter = after.token_policies as string[];
    if (!isDeepStrictEqual(policiesAfter, expected)) drift.push(`${at}: token_policies ${quote(policiesAfter)}, expected ${quote(expected)}`);
    const was = otherSettings(before);
    const now = otherSettings(after);
    for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (!isDeepStrictEqual(was[key], now[key])) drift.push(`${at}: setting ${key} changed from ${quote(was[key])} to ${quote(now[key])}`);
    }
    record = {
      role: rolePath,
      token_policies_before: policiesBefore,
      appended: missing,
      token_policies_after: policiesAfter,
      policies_written: rewritten,
      policy_sha256: sha256,
      settings_preserved: drift.every((d) => !d.includes(": setting ")),
    };
  } catch (err) {
    if (!(err instanceof ReadError)) throw err;
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  process.stdout.write(`${JSON.stringify(record)}\n`);
  for (const d of drift) process.stderr.write(`${d}\n`);
  return drift.length > 0 ? 1 : 0;
}

process.exitCode = main(process.argv.slice(2));
