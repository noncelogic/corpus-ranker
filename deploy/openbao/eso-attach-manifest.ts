// The estate External Secrets role attach manifest
// (devops/openbao/kubernetes-roles/eso-obs.attach.json), read and validated for
// the scripts that apply it (attach-eso.ts) and read it back
// (check-eso-attach.ts). A malformed manifest is a ReadError, never a guess.
//
// Each policy file it names must hold the estate secrets rule itself (Rule:
// policies/placement-defaults.yaml#estate secrets; CR-M3-D2e): exactly one path
// stanza, `kv/data/corpus-ranker/<purpose>`, capabilities ["read"] and nothing
// else, and no two policies granting the same path. A file that breaks it is a
// ReadError too, raised before either script reads or writes OpenBao, so a
// widened file can never be applied to the estate role.
//
// Public: repoRoot, MANIFEST, Attach, readManifest.
import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePolicy, quote, ReadError } from "./policy-grants.ts";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MANIFEST = "devops/openbao/kubernetes-roles/eso-obs.attach.json";

export interface Attach {
  authMount: string;
  role: string;
  policies: Array<{ name: string; file: string }>;
}

/** The attach manifest, validated; a malformed one is a ReadError (exit 2), never a guess. */
export function readManifest(): Attach {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolve(repoRoot, MANIFEST), "utf8"));
  } catch (err) {
    throw new ReadError(`cannot read ${MANIFEST}: ${(err as Error).message}`);
  }
  const m = raw as { auth_mount?: unknown; role?: unknown; mode?: unknown; add_token_policies?: unknown };
  const segment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
  if (typeof m.auth_mount !== "string" || !segment.test(m.auth_mount)) throw new ReadError(`${MANIFEST}: auth_mount is not a mount name`);
  if (typeof m.role !== "string" || !segment.test(m.role)) throw new ReadError(`${MANIFEST}: role is not a role name`);
  if (m.mode !== "add") throw new ReadError(`${MANIFEST}: mode ${quote(m.mode)} is not "add"`);
  if (!Array.isArray(m.add_token_policies) || m.add_token_policies.length === 0) throw new ReadError(`${MANIFEST}: add_token_policies is not a non-empty list`);
  const policiesDir = resolve(repoRoot, "devops", "openbao", "policies") + sep;
  const policies = m.add_token_policies.map((p: unknown, i: number) => {
    const { name, file } = (p ?? {}) as { name?: unknown; file?: unknown };
    if (typeof name !== "string" || !segment.test(name)) throw new ReadError(`${MANIFEST}: add_token_policies[${i}].name is not a policy name`);
    if (typeof file !== "string" || !resolve(repoRoot, file).startsWith(policiesDir)) {
      throw new ReadError(`${MANIFEST}: add_token_policies[${i}].file is not a file in devops/openbao/policies/`);
    }
    return { name, file };
  });
  const granted = new Map<string, string>();
  for (const { name, file } of policies) {
    const path = custodyPath(name, file);
    const other = granted.get(path);
    if (other !== undefined) throw new ReadError(`${MANIFEST}: policy ${name} grants ${path}, which policy ${other} already grants; one policy per custody path`);
    granted.set(path, name);
  }
  return { authMount: m.auth_mount, role: m.role, policies };
}

/** The one exact `kv/data/corpus-ranker/<purpose>` path a policy file grants read on; anything more is a ReadError. */
function custodyPath(name: string, file: string): string {
  let text: string;
  try {
    text = readFileSync(resolve(repoRoot, file), "utf8");
  } catch (err) {
    throw new ReadError(`cannot read ${file}: ${(err as Error).message}`);
  }
  const g = parsePolicy(text);
  const why: string[] = [...g.unsupported, ...g.unparsed.map((u) => `holds something other than path stanzas: ${u}`)];
  why.push(...g.settings.map((s) => `path ${quote(s.path)}: setting ${quote(s.setting)}`));
  const paths = [...g.paths];
  if (paths.length !== 1) why.push(`grants ${paths.length} paths, not exactly one`);
  for (const [path, caps] of paths) {
    if (!/^kv\/data\/corpus-ranker\/[a-z0-9][a-z0-9-]*$/.test(path)) why.push(`path ${quote(path)} is not one exact kv/corpus-ranker/<purpose> data path`);
    if (caps.size !== 1 || !caps.has("read")) why.push(`path ${quote(path)}: capabilities ${quote([...caps].sort())}, not ["read"]`);
  }
  if (why.length > 0) throw new ReadError(`policy ${name} (${file}) breaks the estate secrets rule (one exact path, read-only, no wildcard): ${why.join("; ")}`);
  return paths[0]![0];
}
