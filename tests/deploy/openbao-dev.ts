// A throwaway OpenBao dev server for the deploy/openbao tests, run in the same
// pinned image the ranker's Jobs use (deploy/minio-provision-job.yaml). Needs
// a docker daemon; nothing here talks to the estate.
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { findObject } from "./render.ts";

export const docker = (args: string[]): string => {
  try {
    return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string };
    throw new Error(`docker ${args.join(" ")} failed: ${e.stdout ?? ""}${e.stderr ?? String(err)}`, { cause: err });
  }
};

/** The OpenBao image the ranker's own manifests pin. */
export function openbaoImage(): string {
  const job = findObject("Job", "ranker-minio-provision");
  const spec = job.spec.template.spec;
  const image = [...(spec.initContainers ?? []), ...spec.containers].map((c: { image: string }) => c.image).find((i: string) => i.includes("/openbao/openbao:"));
  assert.ok(image, "the provisioning Job pins no OpenBao image");
  return image;
}

export interface DevOpenBao {
  /** Container name of the server. */
  name: string;
  /** The bao CLI inside the server as `token`; returns [exit code, combined output]. */
  as(token: string, ...args: string[]): [number, string];
  /** The bao CLI as root; fails the test on a non-zero exit. */
  root(...args: string[]): string;
}

/** Start a dev server with a kv-v2 engine at `kv`; removed when the test ends. */
export async function startDevOpenBao(t: TestContext): Promise<DevOpenBao> {
  const name = `crbao-${randomBytes(4).toString("hex")}`;
  docker(["run", "-d", "--name", name, "--entrypoint", "bao", openbaoImage(), "server", "-dev", "-dev-root-token-id=root", "-dev-listen-address=0.0.0.0:8200"]);
  t.after(() => {
    try {
      docker(["rm", "-f", name]);
    } catch {
      // best effort
    }
  });
  const as = (token: string, ...args: string[]): [number, string] => {
    try {
      const out = execFileSync("docker", ["exec", "-e", "BAO_ADDR=http://127.0.0.1:8200", "-e", `BAO_TOKEN=${token}`, name, "bao", ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return [0, out];
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return [e.status ?? 1, `${e.stdout ?? ""}${e.stderr ?? ""}`];
    }
  };
  const root = (...args: string[]): string => {
    const [code, out] = as("root", ...args);
    assert.equal(code, 0, `bao ${args.join(" ")}: ${out}`);
    return out;
  };
  for (let i = 0; ; i++) {
    if (as("root", "status")[0] === 0) break;
    if (i > 60) assert.fail("OpenBao dev server did not start");
    await new Promise((r) => setTimeout(r, 500));
  }
  root("secrets", "enable", "-path=kv", "kv-v2");
  return { name, as, root };
}

/** Parse a policy's `path "<p>" { capabilities = [...] }` stanzas; anything else in it fails the parse. */
export function policyPaths(hcl: string): Map<string, string[]> {
  const body = hcl.replace(/#.*$/gm, "").trim();
  const stanza = /path\s+"([^"]+)"\s*\{\s*capabilities\s*=\s*\[([^\]]*)\]\s*\}/g;
  const paths = new Map<string, string[]>();
  let consumed = "";
  for (const m of body.matchAll(stanza)) {
    assert.ok(!paths.has(m[1]!), `path ${m[1]} is granted twice`);
    paths.set(m[1]!, m[2]!.split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean));
    consumed += m[0];
  }
  assert.equal(body.replace(/\s+/g, ""), consumed.replace(/\s+/g, ""), "the policy holds something other than path stanzas");
  return paths;
}
