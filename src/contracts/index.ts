// Loads the frozen API contract: the versioned A2 JSON Schemas under
// contracts/schemas/<version>/ and the OpenAPI document contracts/openapi.json,
// into one SchemaRegistry so the two can be checked against each other.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SchemaRegistry } from "./json-schema.ts";

export { SchemaRegistry, type JsonSchema, type ValidationError } from "./json-schema.ts";

export const SCHEMA_VERSION = "v1";

// src/contracts/ and dist/contracts/ both sit two levels below the repo root.
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const contractsRoot = join(repoRoot, "contracts");
const schemasDir = join(contractsRoot, "schemas", SCHEMA_VERSION);
const examplesDir = join(contractsRoot, "examples", SCHEMA_VERSION);
const openapiPath = join(contractsRoot, "openapi.json");

export function schemaUri(file: string): string {
  return pathToFileURL(join(schemasDir, file)).href;
}

export function openapiUri(): string {
  return pathToFileURL(openapiPath).href;
}

export interface SchemaManifest {
  version: string;
  /** SPEC A2 section id (e.g. "A2.3") → schema file name. */
  objects: Record<string, string>;
}

export interface Contracts {
  registry: SchemaRegistry;
  manifest: SchemaManifest;
  schemaFiles: string[];
  openapi: unknown;
  /** Named example values of an OpenAPI media type object (inline or externalValue). */
  mediaExamples(media: Record<string, unknown>): [string, unknown][];
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

type Obj = Record<string, any>;

function escape(s: string): string {
  return s.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** JSON pointers of every schema embedded in an OpenAPI 3.1 document. */
function openapiSchemaPointers(doc: Obj): string[] {
  const out: string[] = [];
  for (const name of Object.keys(doc.components?.schemas ?? {})) out.push(`/components/schemas/${escape(name)}`);
  const media = (content: Obj | undefined, at: string) => {
    for (const [type, m] of Object.entries(content ?? {})) if ((m as Obj).schema) out.push(`${at}/content/${escape(type)}/schema`);
  };
  for (const [path, item] of Object.entries((doc.paths ?? {}) as Obj)) {
    for (const [method, op] of Object.entries(item as Obj)) {
      const at = `/paths/${escape(path)}/${method}`;
      if (!op || typeof op !== "object" || Array.isArray(op)) continue;
      ((op as Obj).parameters ?? []).forEach((p: Obj, i: number) => {
        if (p.schema) out.push(`${at}/parameters/${i}/schema`);
      });
      media((op as Obj).requestBody?.content, `${at}/requestBody`);
      for (const [code, res] of Object.entries((op as Obj).responses ?? {})) media((res as Obj).content, `${at}/responses/${code}`);
    }
  }
  return out;
}

export function loadContracts(): Contracts {
  const registry = new SchemaRegistry();
  const manifest = readJson(join(schemasDir, "index.json")) as SchemaManifest;
  const schemaFiles = readdirSync(schemasDir).filter((f) => f.endsWith(".schema.json")).sort();
  for (const f of schemaFiles) registry.add(readJson(join(schemasDir, f)), schemaUri(f));
  const openapi = readJson(openapiPath) as Obj;
  registry.add(openapi, openapiUri(), openapiSchemaPointers(openapi));

  const mediaExamples = (media: Obj): [string, unknown][] => {
    const out: [string, unknown][] = [];
    if ("example" in media) out.push(["example", media.example]);
    for (const [name, ex] of Object.entries((media.examples ?? {}) as Obj)) {
      if ("value" in ex) out.push([name, ex.value]);
      else if (typeof ex.externalValue === "string") {
        out.push([name, readJson(fileURLToPath(new URL(ex.externalValue, openapiUri())))]);
      }
    }
    return out;
  };

  return { registry, manifest, schemaFiles, openapi, mediaExamples };
}

/** Example payload files for one schema: examples/<version>/<name>/{valid,invalid}/*.json */
export function listExamples(name: string): { valid: string[]; invalid: string[] } {
  const list = (kind: string) => {
    const dir = join(examplesDir, name, kind);
    return existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => join(dir, f)) : [];
  };
  return { valid: list("valid"), invalid: list("invalid") };
}
