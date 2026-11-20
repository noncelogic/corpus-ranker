// The estate External Secrets role attach manifest
// (devops/openbao/kubernetes-roles/eso-obs.attach.json), read and validated for
// the scripts that apply it (attach-eso.ts) and read it back
// (check-eso-attach.ts). A malformed manifest is a ReadError, never a guess.
//
// Public: repoRoot, MANIFEST, Attach, readManifest.
import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { quote, ReadError } from "./policy-grants.ts";

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
  return { authMount: m.auth_mount, role: m.role, policies };
}
