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
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const NAME = "corpus-ranker-api-keys";
const AUTH_MOUNT = "kubernetes";
const ROLE_PATH = `auth/${AUTH_MOUNT}/role/${NAME}`;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const policyFile = resolve(repoRoot, "devops", "openbao", "policies", `${NAME}.hcl`);
const roleFile = resolve(repoRoot, "devops", "openbao", "kubernetes-roles", `${NAME}.json`);

class ReadError extends Error {}

/** A policy's grants: path -> capabilities, plus any other stanza setting and any text that is not a path stanza. */
interface Grants {
  paths: Map<string, Set<string>>;
  settings: Array<{ path: string; setting: string }>;
  unparsed: string[];
}

type Token = { kind: "string" | "word" | "punct"; text: string };

function tokenize(hcl: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < hcl.length) {
    const c = hcl[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "#" || (c === "/" && hcl[i + 1] === "/")) {
      while (i < hcl.length && hcl[i] !== "\n") i++;
    } else if (c === "/" && hcl[i + 1] === "*") {
      const end = hcl.indexOf("*/", i + 2);
      i = end < 0 ? hcl.length : end + 2;
    } else if (c === '"') {
      let s = "";
      i++;
      while (i < hcl.length && hcl[i] !== '"') {
        if (hcl[i] === "\\" && i + 1 < hcl.length) i++;
        s += hcl[i++];
      }
      i++;
      tokens.push({ kind: "string", text: s });
    } else if ("{}[]=,:".includes(c)) {
      tokens.push({ kind: "punct", text: c });
      i++;
    } else {
      let w = "";
      while (i < hcl.length && !/[\s{}[\]=,:"#]/.test(hcl[i]!)) w += hcl[i++];
      tokens.push({ kind: "word", text: w });
    }
  }
  return tokens;
}

/** Parse the `path "<p>" { capabilities = [...] }` stanzas of an HCL policy; anything else is reported, not dropped. */
function parsePolicy(hcl: string): Grants {
  const t = tokenize(hcl);
  const grants: Grants = { paths: new Map(), settings: [], unparsed: [] };
  let i = 0;
  const at = (text: string) => t[i]?.kind === "punct" && t[i]!.text === text;
  /** Skip one value (string, word, list or block), returning the strings directly inside a list. */
  const skipValue = (): string[] | undefined => {
    const open = t[i]?.text;
    if (t[i]?.kind === "punct" && (open === "[" || open === "{")) {
      const close = open === "[" ? "]" : "}";
      const items: string[] = [];
      let depth = 0;
      for (; i < t.length; i++) {
        if (t[i]!.kind === "punct" && (t[i]!.text === "[" || t[i]!.text === "{")) depth++;
        else if (t[i]!.kind === "punct" && (t[i]!.text === "]" || t[i]!.text === "}")) depth--;
        else if (depth === 1 && t[i]!.kind === "string") items.push(t[i]!.text);
        if (depth === 0) {
          i++;
          return open === "[" && t[i - 1]!.text === close ? items : undefined;
        }
      }
      return undefined;
    }
    i++;
    return undefined;
  };
  while (i < t.length) {
    if (t[i]!.kind === "word" && t[i]!.text === "path" && t[i + 1]?.kind === "string") {
      const path = t[i + 1]!.text;
      i += 2;
      if (at("=")) i++;
      if (!at("{")) {
        grants.unparsed.push(`path ${path} has no { } stanza`);
        continue;
      }
      i++;
      const caps = grants.paths.get(path) ?? new Set<string>();
      grants.paths.set(path, caps);
      while (i < t.length && !at("}")) {
        const key = t[i]!;
        i++;
        if (key.kind === "punct" && key.text === ",") continue;
        if (at("=") || at(":")) i++;
        const items = skipValue();
        if ((key.kind === "word" || key.kind === "string") && key.text === "capabilities" && items) {
          for (const c of items) caps.add(c);
        } else {
          grants.settings.push({ path, setting: key.text });
        }
      }
      if (at("}")) i++;
      else grants.unparsed.push(`path ${path}: unterminated stanza`);
    } else {
      const start = t[i]!.text;
      i++;
      if (at("=") || at(":")) i++;
      if (at("{") || at("[")) skipValue();
      grants.unparsed.push(start);
    }
  }
  return grants;
}

/** "5m", "300s", "1h", "300" or 300 -> seconds; undefined when not a duration. */
function seconds(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string") return undefined;
  const m = /^(\d+)(s|m|h)?$/.exec(v.trim());
  if (!m) return undefined;
  return Number(m[1]) * ({ s: 1, m: 60, h: 3600 } as Record<string, number>)[m[2] ?? "s"]!;
}

const isWildcard = (p: string) => /[*+]/.test(p);
const quote = (v: unknown) => JSON.stringify(v);

function comparePolicy(declared: Grants, read: Grants): string[] {
  const drift: string[] = [];
  const at = `policy ${NAME}`;
  for (const u of read.unparsed) drift.push(`${at}: holds something other than path stanzas: ${u}`);
  for (const [path, caps] of read.paths) {
    const want = declared.paths.get(path);
    if (!want) {
      drift.push(`${at}: path ${path} is not declared${isWildcard(path) ? " (wildcard)" : ""}: capabilities ${quote([...caps].sort())}`);
      continue;
    }
    for (const c of [...caps].sort()) if (!want.has(c)) drift.push(`${at}: path ${path}: capability ${quote(c)} is not declared`);
    for (const c of [...want].sort()) if (!caps.has(c)) drift.push(`${at}: path ${path}: capability ${quote(c)} is declared but absent`);
  }
  for (const path of declared.paths.keys()) {
    if (!read.paths.has(path)) drift.push(`${at}: path ${path} is declared but absent`);
  }
  const declaredSettings = new Set(declared.settings.map((s) => `${s.path}\0${s.setting}`));
  for (const s of read.settings) {
    if (!declaredSettings.has(`${s.path}\0${s.setting}`)) drift.push(`${at}: path ${s.path}: setting ${quote(s.setting)} is not declared`);
  }
  return drift;
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

/** Run `bao`; stdout on success, undefined when OpenBao says the object does not exist. */
function bao(args: string[], notFound: RegExp): string | undefined {
  const r = spawnSync("bao", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (r.error) throw new ReadError(`cannot run bao: ${r.error.message}`);
  if (r.status === 0) return r.stdout;
  const err = `${r.stderr ?? ""}${r.stdout ?? ""}`.trim();
  if (notFound.test(err)) return undefined;
  throw new ReadError(`bao ${args.join(" ")} failed (exit ${r.status ?? r.signal}): ${err.split("\n")[0] ?? ""}`);
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
      const d = comparePolicy(parsePolicy(readFileSync(policyFile, "utf8")), parsePolicy(policyText));
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
