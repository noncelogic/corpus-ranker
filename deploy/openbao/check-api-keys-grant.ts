#!/usr/bin/env node
// Read the API key Job's write-back grant back from OpenBao and check it is
// exactly the one the repository declares:
//
//   node deploy/openbao/check-api-keys-grant.ts
//
// The key generation Sync hook Job (deploy/api-keys-job.yaml) logs in through
// the Kubernetes auth role corpus-ranker-api-keys, which carries the policy
// corpus-ranker-api-keys. Both are declared in devops/openbao/
// (policies/corpus-ranker-api-keys.hcl, kubernetes-roles/corpus-ranker-api-keys.json)
// and applied estate-side by an operator. This script reads them back with
// `bao policy read` and `bao read auth/kubernetes/role/...` and compares:
//
//   - the policy's path stanzas: every path and every capability, both ways
//     (an added capability, a second or wildcard path, a missing grant), and
//     any setting other than `capabilities` in a stanza;
//   - each role field the role file declares: list fields as sets, both ways
//     (another bound service account or namespace, an extra attached
//     policy), TTLs in seconds; and every role field it does not declare
//     against OpenBao's default (a namespace selector, bound CIDRs, ...).
//
// The expected grant is the estate's credential_writeback rule as
// CR-M3-DEC-KEYGEN-GRANT applies it (Rule:
// policies/placement-defaults.yaml#estate): the one product data path through
// the Job's own role; no metadata, no delete, no list, no other path.
//
// Run estate-side, logged in to OpenBao (`bao login`) with rights to read
// policies and auth roles. It reads names and policy text only, never a
// secret, and prints only what it compares. Exit 0: both match. Exit 1: each
// difference is named on stderr, one per line. Exit 2: the reads failed for
// another reason (unreachable, permission denied), or a usage error.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bao, comparePolicy, parsePolicy, quote, ReadError } from "./policy-grants.ts";

const NAME = "corpus-ranker-api-keys";
const AUTH_MOUNT = "kubernetes";
const ROLE_PATH = `auth/${AUTH_MOUNT}/role/${NAME}`;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const policyFile = resolve(repoRoot, "devops", "openbao", "policies", `${NAME}.hcl`);
const roleFile = resolve(repoRoot, "devops", "openbao", "kubernetes-roles", `${NAME}.json`);

/** "5m", "300s", "1h", "300" or 300 -> seconds; undefined when not a duration. */
function seconds(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return undefined;
  const m = /^(\d+)(s|m|h)?$/.exec(v.trim());
  if (!m) return undefined;
  return Number(m[1]) * ({ s: 1, m: 60, h: 3600 } as Record<string, number>)[m[2] ?? "s"]!;
}

/**
 * What OpenBao reads back for a Kubernetes auth role field the role file does
 * not declare: the field's default. A non-default value there widens or
 * changes the grant without the file saying so (for example
 * bound_service_account_namespace_selector, which OpenBao ORs with
 * bound_service_account_namespaces), so it is drift.
 */
const ROLE_DEFAULTS: Record<string, unknown> = {
  alias_name_source: "serviceaccount_uid",
  audience: "",
  bound_service_account_names: [],
  bound_service_account_namespace_selector: "",
  bound_service_account_namespaces: [],
  token_bound_cidrs: [],
  token_explicit_max_ttl: 0,
  token_max_ttl: 0,
  token_no_default_policy: false,
  token_num_uses: 0,
  token_period: 0,
  token_policies: [],
  token_strictly_bind_ip: false,
  token_ttl: 0,
  token_type: "default",
};

/** Deprecated role fields OpenBao may echo as a copy of their token_* field; checked against that field's read value. */
const LEGACY_ROLE_FIELDS: Record<string, string> = {
  bound_cidrs: "token_bound_cidrs",
  max_ttl: "token_max_ttl",
  num_uses: "token_num_uses",
  period: "token_period",
  ttl: "token_ttl",
};

/** An unset value as OpenBao reads it back: empty string or list, zero, false or null. */
const isEmptyValue = (v: unknown) => v === undefined || v === null || v === "" || v === 0 || v === false || (Array.isArray(v) && v.length === 0);

/** Equal as OpenBao values: lists as sets, durations in seconds, empty values alike. */
function sameValue(field: string, a: unknown, b: unknown): boolean {
  if (isEmptyValue(a) && isEmptyValue(b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    const sa = new Set(a.map(String));
    const sb = new Set(b.map(String));
    return sa.size === sb.size && [...sa].every((v) => sb.has(v));
  }
  if (/(^|_)(ttl|period)$/.test(field) && seconds(a) !== undefined) return seconds(a) === seconds(b);
  return quote(a) === quote(b);
}

function compareRole(declared: Record<string, unknown>, read: Record<string, unknown>): string[] {
  const drift: string[] = [];
  const at = `role ${ROLE_PATH}`;
  for (const [field, want] of Object.entries(declared)) {
    const got = read[field];
    if (Array.isArray(want)) {
      if (!Array.isArray(got)) {
        drift.push(`${at}: ${field}: read ${quote(got)}, declared ${quote(want)}`);
        continue;
      }
      const wantSet = new Set(want.map(String));
      const gotSet = new Set(got.map(String));
      for (const v of [...gotSet].sort()) if (!wantSet.has(v)) drift.push(`${at}: ${field}: ${quote(v)} is not declared`);
      for (const v of [...wantSet].sort()) if (!gotSet.has(v)) drift.push(`${at}: ${field}: ${quote(v)} is declared but absent`);
    } else if (/(^|_)ttl$/.test(field) && seconds(want) !== undefined) {
      const w = seconds(want)!;
      const g = seconds(got);
      if (g !== w) drift.push(`${at}: ${field}: read ${g === undefined ? quote(got) : `${g}s`}, declared ${w}s (${want})`);
    } else if (quote(got) !== quote(want)) {
      drift.push(`${at}: ${field}: read ${quote(got)}, declared ${quote(want)}`);
    }
  }
  // Every field the file leaves out must read back as its default; one OpenBao does not know of must read back unset.
  for (const [field, got] of Object.entries(read).sort(([a], [b]) => a.localeCompare(b))) {
    if (field in declared || field === "policies") continue;
    const legacy = LEGACY_ROLE_FIELDS[field];
    const want = legacy !== undefined ? read[legacy] : ROLE_DEFAULTS[field];
    if (!sameValue(field, got, want)) {
      const what = legacy !== undefined ? `${legacy} (${quote(want)})` : field in ROLE_DEFAULTS ? `the default ${quote(want)}` : "unset";
      drift.push(`${at}: ${field}: read ${quote(got)}, not declared (expected ${what})`);
    }
  }
  // OpenBao may still echo the deprecated `policies` alongside token_policies; an extra policy there is drift too.
  if (Array.isArray(declared.token_policies) && Array.isArray(read.policies) && read.policies.length > 0 && !("policies" in declared)) {
    const want = new Set(declared.token_policies.map(String));
    for (const p of read.policies.map(String).sort()) if (!want.has(p)) drift.push(`${at}: policies: ${quote(p)} is not declared`);
  }
  return drift;
}

function main(argv: string[]): number {
  if (argv.length > 0) {
    process.stderr.write("usage: node deploy/openbao/check-api-keys-grant.ts\n");
    return 2;
  }
  const drift: string[] = [];
  try {
    const policyText = bao(["policy", "read", NAME], /no policy named/i);
    if (policyText === undefined) {
      drift.push(`policy ${NAME}: absent`);
    } else {
      const d = comparePolicy(NAME, parsePolicy(readFileSync(policyFile, "utf8")), parsePolicy(policyText));
      if (d.length === 0) process.stdout.write(`policy ${NAME} matches ${policyFile.slice(repoRoot.length + 1)}\n`);
      drift.push(...d);
    }
    const roleText = bao(["read", "-format=json", ROLE_PATH], /no value found at/i);
    if (roleText === undefined) {
      drift.push(`role ${ROLE_PATH}: absent`);
    } else {
      let data: unknown;
      try {
        data = (JSON.parse(roleText) as { data?: unknown }).data;
      } catch {
        throw new ReadError(`bao read ${ROLE_PATH} returned something other than JSON`);
      }
      if (typeof data !== "object" || data === null) throw new ReadError(`bao read ${ROLE_PATH} returned no role data`);
      const d = compareRole(JSON.parse(readFileSync(roleFile, "utf8")) as Record<string, unknown>, data as Record<string, unknown>);
      if (d.length === 0) process.stdout.write(`role ${ROLE_PATH} matches ${roleFile.slice(repoRoot.length + 1)}\n`);
      drift.push(...d);
    }
  } catch (err) {
    if (!(err instanceof ReadError)) throw err;
    process.stderr.write(`${err.message}\n`);
    return 2;
  }
  for (const d of drift) process.stderr.write(`${d}\n`);
  if (drift.length > 0) {
    process.stderr.write(`${drift.length} difference(s) from the declared grant in devops/openbao/\n`);
    return 1;
  }
  return 0;
}

process.exitCode = main(process.argv.slice(2));
