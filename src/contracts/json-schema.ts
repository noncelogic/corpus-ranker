// A small JSON Schema (draft 2020-12) validator covering the keyword subset the
// ranker contracts use. Unsupported keywords are reported by `lint()` rather
// than silently ignored, so a schema can never rely on a constraint that is not
// actually enforced.
export type JsonSchema = boolean | { [keyword: string]: unknown };

export interface ValidationError {
  instancePath: string;
  schemaUri: string;
  message: string;
}

const ANNOTATIONS = new Set(["$schema", "$id", "$comment", "title", "description", "examples", "default", "deprecated", "readOnly", "writeOnly"]);
const SCHEMA_MAPS = ["properties", "$defs"] as const;
const SCHEMA_SINGLES = ["items", "additionalProperties", "not"] as const;
const SCHEMA_ARRAYS = ["allOf", "anyOf", "oneOf"] as const;
const ASSERTIONS = new Set([
  "$ref", "type", "enum", "const", "required", "minProperties", "maxProperties",
  "minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "pattern", "format",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
]);
const KNOWN = new Set<string>([...ANNOTATIONS, ...SCHEMA_MAPS, ...SCHEMA_SINGLES, ...SCHEMA_ARRAYS, ...ASSERTIONS]);
const TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);

const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const FORMATS: Record<string, (s: string) => boolean> = {
  "date-time": (s) => DATE_TIME.test(s) && !Number.isNaN(Date.parse(s)),
  uri: (s) => URL.canParse(s) && /^[a-z][a-z0-9+.-]*:/i.test(s),
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function typeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function matchesType(v: unknown, t: string): boolean {
  switch (t) {
    case "integer": return typeof v === "number" && Number.isInteger(v);
    case "number": return typeof v === "number" && Number.isFinite(v);
    case "object": return isObject(v);
    default: return typeOf(v) === t;
  }
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

function pointerEscape(s: string): string {
  return s.replace(/~/g, "~0").replace(/\//g, "~1");
}

interface Doc { root: unknown; base: string }

/** Holds schema documents by URI and validates instances against them. */
export class SchemaRegistry {
  readonly #docs = new Map<string, Doc>();
  readonly #roots: string[] = [];

  /**
   * Register a document fetched from `retrievalUri`. If the document declares a
   * `$id`, it is also registered under that id, which becomes its base URI.
   * `schemaPointers` lists the JSON pointers inside the document that hold
   * schemas (default: the root), used by `lint()` and `reachableFrom()`.
   */
  add(root: unknown, retrievalUri: string, schemaPointers: string[] = [""]): void {
    const retrieval = stripFragment(retrievalUri);
    const id = isObject(root) && typeof root.$id === "string" ? stripFragment(new URL(root.$id, retrieval).href) : undefined;
    const doc: Doc = { root, base: id ?? retrieval };
    this.#docs.set(retrieval, doc);
    if (id) this.#docs.set(id, doc);
    for (const p of schemaPointers) this.#roots.push(`${retrieval}#${p}`);
  }

  get(uri: string): unknown {
    return this.#resolve(uri).schema;
  }

  validate(instance: unknown, uri: string): ValidationError[] {
    const { schema, base } = this.#resolve(uri);
    const errors: ValidationError[] = [];
    this.#check(instance, schema as JsonSchema, base, uri, "", errors);
    return errors;
  }

  /** Report unknown keywords, malformed keyword values and unresolvable $refs. */
  lint(): string[] {
    const problems: string[] = [];
    for (const rootUri of this.#roots) {
      const { schema, base } = this.#resolve(rootUri);
      this.#walk(schema, base, rootUri, (s, b, at) => {
        for (const [k, v] of Object.entries(s)) {
          if (!KNOWN.has(k)) problems.push(`${at}: unsupported keyword "${k}"`);
          if (k === "type") {
            const ts = Array.isArray(v) ? v : [v];
            for (const t of ts) if (!TYPES.has(t as string)) problems.push(`${at}: unknown type ${String(t)}`);
          }
          if (k === "format" && !(String(v) in FORMATS)) problems.push(`${at}: unsupported format "${String(v)}"`);
          if (k === "pattern") {
            try { new RegExp(String(v), "u"); } catch { problems.push(`${at}: invalid pattern`); }
          }
          if (k === "$ref") {
            try { this.#resolve(new URL(String(v), b).href); } catch (e) { problems.push(`${at}: ${(e as Error).message}`); }
          }
        }
      });
    }
    return problems;
  }

  /** Document URIs (without fragment) reachable by $ref from the schemas inside `docUri`. */
  reachableFrom(docUri: string): string[] {
    const seen = new Set<string>();
    const queue = this.#roots.filter((r) => stripFragment(r) === stripFragment(docUri));
    while (queue.length > 0) {
      const uri = queue.pop()!;
      const { schema, base } = this.#resolve(uri);
      this.#walk(schema, base, uri, (s, b) => {
        if (typeof s.$ref !== "string") return;
        const target = new URL(s.$ref, b).href;
        const doc = this.#docs.get(stripFragment(target))!;
        const key = [...this.#docs.entries()].find(([, d]) => d === doc)![0];
        if (!seen.has(key)) {
          seen.add(key);
          queue.push(`${key}#`);
        }
      });
    }
    return [...seen];
  }

  #resolve(uri: string): { schema: unknown; base: string } {
    const url = new URL(uri);
    const doc = this.#docs.get(stripFragment(url.href));
    if (!doc) throw new Error(`unresolvable $ref ${uri}`);
    let node: unknown = doc.root;
    const fragment = decodeURIComponent(url.hash.slice(1));
    if (fragment !== "") {
      if (!fragment.startsWith("/")) throw new Error(`unsupported $ref fragment ${uri}`);
      for (const raw of fragment.slice(1).split("/")) {
        const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
        if (!isObject(node) && !Array.isArray(node)) throw new Error(`unresolvable $ref ${uri}`);
        node = (node as Record<string, unknown>)[part];
        if (node === undefined) throw new Error(`unresolvable $ref ${uri}`);
      }
    }
    return { schema: node, base: doc.base };
  }

  #walk(schema: unknown, base: string, at: string, visit: (s: Record<string, unknown>, base: string, at: string) => void): void {
    if (typeof schema === "boolean") return;
    if (!isObject(schema)) throw new Error(`${at}: not a schema`);
    visit(schema, base, at);
    for (const k of SCHEMA_MAPS) {
      if (isObject(schema[k])) for (const [n, s] of Object.entries(schema[k])) this.#walk(s, base, `${at}/${k}/${pointerEscape(n)}`, visit);
    }
    for (const k of SCHEMA_SINGLES) if (k in schema) this.#walk(schema[k], base, `${at}/${k}`, visit);
    for (const k of SCHEMA_ARRAYS) {
      if (Array.isArray(schema[k])) schema[k].forEach((s, i) => this.#walk(s, base, `${at}/${k}/${i}`, visit));
    }
  }

  #check(v: unknown, schema: JsonSchema, base: string, at: string, path: string, errors: ValidationError[]): void {
    const fail = (message: string) => errors.push({ instancePath: path, schemaUri: at, message });
    if (schema === true) return;
    if (schema === false) return void fail("no value is allowed here");

    if (typeof schema.$ref === "string") {
      const target = new URL(schema.$ref, base).href;
      const { schema: s, base: b } = this.#resolve(target);
      this.#check(v, s as JsonSchema, b, target, path, errors);
    }
    if (schema.type !== undefined) {
      const ts = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
      if (!ts.some((t) => matchesType(v, t))) return void fail(`must be ${ts.join(" or ")}, got ${typeOf(v)}`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, v))) fail(`must be one of ${JSON.stringify(schema.enum)}`);
    if ("const" in schema && !deepEqual(schema.const, v)) fail(`must equal ${JSON.stringify(schema.const)}`);

    if (typeof v === "string") {
      const len = [...v].length;
      if (typeof schema.minLength === "number" && len < schema.minLength) fail(`must have length >= ${schema.minLength}`);
      if (typeof schema.maxLength === "number" && len > schema.maxLength) fail(`must have length <= ${schema.maxLength}`);
      if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(v)) fail(`must match ${schema.pattern}`);
      if (typeof schema.format === "string" && !FORMATS[schema.format]!(v)) fail(`must be a valid ${schema.format}`);
    }
    if (typeof v === "number") {
      if (typeof schema.minimum === "number" && v < schema.minimum) fail(`must be >= ${schema.minimum}`);
      if (typeof schema.maximum === "number" && v > schema.maximum) fail(`must be <= ${schema.maximum}`);
      if (typeof schema.exclusiveMinimum === "number" && v <= schema.exclusiveMinimum) fail(`must be > ${schema.exclusiveMinimum}`);
      if (typeof schema.exclusiveMaximum === "number" && v >= schema.exclusiveMaximum) fail(`must be < ${schema.exclusiveMaximum}`);
    }
    if (Array.isArray(v)) {
      if (typeof schema.minItems === "number" && v.length < schema.minItems) fail(`must have >= ${schema.minItems} items`);
      if (typeof schema.maxItems === "number" && v.length > schema.maxItems) fail(`must have <= ${schema.maxItems} items`);
      if (schema.uniqueItems === true && v.some((x, i) => v.findIndex((y) => deepEqual(x, y)) !== i)) fail("items must be unique");
      if (schema.items !== undefined) v.forEach((x, i) => this.#check(x, schema.items as JsonSchema, base, `${at}/items`, `${path}/${i}`, errors));
    }
    if (isObject(v)) {
      const n = Object.keys(v).length;
      if (typeof schema.minProperties === "number" && n < schema.minProperties) fail(`must have >= ${schema.minProperties} properties`);
      if (typeof schema.maxProperties === "number" && n > schema.maxProperties) fail(`must have <= ${schema.maxProperties} properties`);
      for (const r of (schema.required as string[] | undefined) ?? []) if (!(r in v)) fail(`missing required property "${r}"`);
      const props = isObject(schema.properties) ? schema.properties : {};
      for (const [k, x] of Object.entries(v)) {
        const p = `${path}/${pointerEscape(k)}`;
        if (k in props) this.#check(x, props[k] as JsonSchema, base, `${at}/properties/${pointerEscape(k)}`, p, errors);
        else if (schema.additionalProperties !== undefined) {
          if (schema.additionalProperties === false) errors.push({ instancePath: p, schemaUri: at, message: "unexpected property" });
          else this.#check(x, schema.additionalProperties as JsonSchema, base, `${at}/additionalProperties`, p, errors);
        }
      }
    }

    const sub = (s: unknown, where: string) => {
      const e: ValidationError[] = [];
      this.#check(v, s as JsonSchema, base, where, path, e);
      return e;
    };
    if (Array.isArray(schema.allOf)) schema.allOf.forEach((s, i) => errors.push(...sub(s, `${at}/allOf/${i}`)));
    if (Array.isArray(schema.anyOf) && !schema.anyOf.some((s, i) => sub(s, `${at}/anyOf/${i}`).length === 0)) {
      fail("must match at least one schema in anyOf");
    }
    if (Array.isArray(schema.oneOf)) {
      const passing = schema.oneOf.filter((s, i) => sub(s, `${at}/oneOf/${i}`).length === 0).length;
      if (passing !== 1) fail(`must match exactly one schema in oneOf (matched ${passing})`);
    }
    if (schema.not !== undefined && sub(schema.not, `${at}/not`).length === 0) fail("must not match the schema in not");
  }
}

function stripFragment(uri: string): string {
  const i = uri.indexOf("#");
  return i < 0 ? uri : uri.slice(0, i);
}
