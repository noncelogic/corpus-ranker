#!/usr/bin/env node
// Read the ranker's External Secrets read policies and their attachment to the
// estate role eso-obs back from OpenBao, and check them against the
// repository's attach manifest:
//
//   node deploy/openbao/check-eso-attach.ts
//
// devops/openbao/kubernetes-roles/eso-obs.attach.json declares an add-only
// attachment: each policy it names (add_token_policies, each with its file in
// devops/openbao/policies/) is attached to the Kubernetes auth role it names
// (eso-obs on mount kubernetes, the role the `openbao` ClusterSecretStore logs
// in with) beside the role's existing policies. CRANK-188 applies it
// estate-side. This script reads the role with
// `bao read -format=json auth/<mount>/role/<role>` and each named policy with
// `bao policy read <name>`, and compares:
//
//   - the role's token_policies include every policy the manifest names. The
//     role's other policies are the estate's, not this product's: the
//     pre-apply list is not in the repository, so nothing is asserted about
//     them and none is read or printed;
//   - each named policy's path stanzas equal its repository file: every path
//     and every capability, both ways (an added capability, a second or
//     wildcard path, a missing grant), and any setting other than
//     `capabilities` in a stanza (Rule: policies/placement-defaults.yaml#estate
//     secrets: one exact path, read-only, no wildcard).
//
// The checker is driven by the manifest alone: a policy added to it is
// checked with no change here.
//
// Run estate-side, logged in to OpenBao (`bao login`) with rights to read
// policies and auth roles. It reads names and policy text only, never a
// secret, and prints only what it compares. Exit 0: everything matches.
// Exit 1: each difference is named on stderr, one per line. Exit 2: the reads
// failed for another reason (unreachable, permission denied), the manifest
// or a policy file it names is unreadable or grants more than read on one
// exact kv/corpus-ranker/<purpose> path, or a usage error.
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { bao, comparePolicy, parsePolicy, quote, ReadError } from "./policy-grants.ts";
import { MANIFEST, readManifest, repoRoot } from "./eso-attach-manifest.ts";

function main(argv: string[]): number {
  if (argv.length > 0) {
    process.stderr.write("usage: node deploy/openbao/check-eso-attach.ts\n");
    return 2;
  }
  const drift: string[] = [];
  try {
    const attach = readManifest();
    const rolePath = `auth/${attach.authMount}/role/${attach.role}`;
    const at = `role ${rolePath}`;
    const roleText = bao(["read", "-format=json", rolePath], /no value found at/i);
    if (roleText === undefined) {
      drift.push(`${at}: absent`);
    } else {
      let data: unknown;
      try {
        data = (JSON.parse(roleText) as { data?: unknown }).data;
      } catch {
        throw new ReadError(`bao read ${rolePath} returned something other than JSON`);
      }
      if (typeof data !== "object" || data === null) throw new ReadError(`bao read ${rolePath} returned no role data`);
      const got = (data as { token_policies?: unknown }).token_policies;
      if (!Array.isArray(got)) throw new ReadError(`bao read ${rolePath} returned no token_policies list`);
      const held = new Set(got.map(String));
      for (const { name } of attach.policies) {
        if (held.has(name)) process.stdout.write(`${at}: token_policies include ${name}\n`);
        else drift.push(`${at}: token_policies: ${quote(name)} is declared in ${MANIFEST} but absent`);
      }
    }
    for (const { name, file } of attach.policies) {
      let declaredText: string;
      try {
        declaredText = readFileSync(resolve(repoRoot, file), "utf8");
      } catch (err) {
        throw new ReadError(`cannot read ${file}: ${(err as Error).message}`);
      }
      const policyText = bao(["policy", "read", name], /no policy named/i);
      if (policyText === undefined) {
        drift.push(`policy ${name}: absent`);
        continue;
      }
      const d = comparePolicy(name, parsePolicy(declaredText), parsePolicy(policyText));
      if (d.length === 0) process.stdout.write(`policy ${name} matches ${relative(repoRoot, resolve(repoRoot, file))}\n`);
      drift.push(...d);
    }
  } catch (err) {
    if (!(err instanceof ReadError)) throw err;
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  for (const d of drift) process.stderr.write(`${d}\n`);
  if (drift.length > 0) {
    process.stderr.write(`${drift.length} difference(s) from ${MANIFEST}\n`);
    return 1;
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
