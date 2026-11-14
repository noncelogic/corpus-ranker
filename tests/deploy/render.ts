// Shared helpers for the deploy/ manifest tests: render the overlay with a
// local kustomize binary and read the rendered YAML without a YAML library
// (no new dependency; docs/EXTERNAL-REVIEW.md §3).
//
// Requires a kustomize binary: $KUSTOMIZE, `kustomize` on PATH, or
// `kubectl kustomize` (GitHub-hosted ubuntu runners ship both). Rendering is
// purely local; nothing here talks to a cluster.
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const deployDir = resolve(repoRoot, "deploy");

function tryRun(cmd: string, args: string[]): string | undefined {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export function kustomizeBuild(dir: string = deployDir): string {
  const candidates: Array<[string, string[]]> = [];
  if (process.env.KUSTOMIZE) candidates.push([process.env.KUSTOMIZE, ["build", dir]]);
  candidates.push(["kustomize", ["build", dir]], ["kubectl", ["kustomize", dir]]);
  for (const [cmd, args] of candidates) {
    const out = tryRun(cmd, args);
    if (out !== undefined) return out;
  }
  throw new Error("no kustomize found: install kustomize or kubectl, or set $KUSTOMIZE");
}

// ---------------------------------------------------------------------------
// A deliberately small YAML reader for block-style manifests as written in
// deploy/ and as emitted by kustomize: nested maps and lists, plain, quoted
// and `|`/`>` block scalars, simple flow lists/maps, and `#` comments.
// Anchors, tags and multi-line flow collections are not supported.

export type Yaml = string | number | boolean | null | Yaml[] | { [key: string]: Yaml };

interface Line {
  indent: number;
  text: string; // without indentation
  raw: string;
}

const isBlank = (raw: string): boolean => raw.trim() === "" || raw.trim().startsWith("#");

function stripComment(s: string): string {
  // Only plain scalars carry trailing comments; quoted ones are left alone.
  if (s.startsWith('"') || s.startsWith("'")) return s;
  const i = s.search(/\s#/);
  return (i === -1 ? s : s.slice(0, i)).trimEnd();
}

function splitFlow(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let cur = "";
  for (const ch of body) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = undefined;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === "[" || ch === "{") {
      depth++;
      cur += ch;
    } else if (ch === "]" || ch === "}") {
      depth--;
      cur += ch;
    } else if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim() !== "") parts.push(cur.trim());
  return parts;
}

function scalar(raw: string): Yaml {
  const s = stripComment(raw.trim());
  if (s.startsWith('"')) return JSON.parse(s.replace(/\n/g, "\\n")) as string;
  if (s.startsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith("[")) return splitFlow(s.slice(1, -1)).map(scalar);
  if (s.startsWith("{")) {
    const out: Record<string, Yaml> = {};
    for (const part of splitFlow(s.slice(1, -1))) {
      const [k, v] = splitKey(part);
      out[k] = scalar(v);
    }
    return out;
  }
  if (s === "" || s === "~" || s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

/** Split `key: rest` (key possibly quoted); throws if the line is not a map entry. */
function splitKey(text: string): [string, string] {
  const m = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#][^:#]*?)\s*:(?:\s+(.*)|\s*)$/.exec(text);
  if (!m) throw new Error(`not a YAML map entry: ${text}`);
  const key = scalar(m[1]!);
  return [String(key), m[2] ?? ""];
}

const isMapEntry = (text: string): boolean => {
  try {
    splitKey(text);
    return true;
  } catch {
    return false;
  }
};

class Reader {
  private i = 0;
  private readonly lines: Line[];
  constructor(lines: Line[]) {
    this.lines = lines;
  }

  private peek(): Line | undefined {
    while (this.i < this.lines.length && isBlank(this.lines[this.i]!.raw)) this.i++;
    return this.lines[this.i];
  }

  parseNode(indent: number): Yaml {
    const line = this.peek();
    if (!line || line.indent < indent) return null;
    if (line.text === "-" || line.text.startsWith("- ")) return this.parseSeq(line.indent);
    return this.parseMap(line.indent);
  }

  private parseSeq(indent: number): Yaml[] {
    const out: Yaml[] = [];
    for (let line = this.peek(); line && line.indent === indent && (line.text === "-" || line.text.startsWith("- ")); line = this.peek()) {
      const rest = line.text === "-" ? "" : line.text.slice(2);
      const restTrim = rest.trimStart();
      const itemIndent = indent + 2 + (rest.length - restTrim.length);
      if (restTrim === "") {
        this.i++;
        out.push(this.parseNode(indent + 1));
      } else if (restTrim.startsWith("- ") || (isMapEntry(restTrim) && !/^["'[{]/.test(restTrim))) {
        // The item's first entry sits on the dash line: re-read it as indented.
        this.lines[this.i] = { indent: itemIndent, text: restTrim, raw: " ".repeat(itemIndent) + restTrim };
        out.push(this.parseNode(itemIndent));
      } else {
        this.i++;
        out.push(this.blockOrScalar(restTrim, indent));
      }
    }
    return out;
  }

  private parseMap(indent: number): Record<string, Yaml> {
    const out: Record<string, Yaml> = {};
    for (let line = this.peek(); line && line.indent === indent && !line.text.startsWith("- "); line = this.peek()) {
      const [key, rest] = splitKey(line.text);
      this.i++;
      if (stripComment(rest) === "") {
        const next = this.peek();
        if (next && (next.indent > indent || (next.indent === indent && next.text.startsWith("- ")))) {
          out[key] = this.parseNode(next.indent);
        } else out[key] = null;
      } else out[key] = this.blockOrScalar(rest, indent);
    }
    return out;
  }

  private blockOrScalar(rest: string, parentIndent: number): Yaml {
    const head = stripComment(rest);
    const m = /^([|>])([+-]?)$/.exec(head);
    if (!m) return scalar(this.foldContinuation(rest, parentIndent));
    const body: string[] = [];
    let blockIndent: number | undefined;
    while (this.i < this.lines.length) {
      const l = this.lines[this.i]!;
      if (l.raw.trim() === "") {
        body.push("");
        this.i++;
        continue;
      }
      if (l.indent <= parentIndent) break;
      blockIndent ??= l.indent;
      body.push(l.raw.slice(blockIndent));
      this.i++;
    }
    while (body.length > 0 && body[body.length - 1] === "") body.pop();
    const text = m[1] === ">" ? body.join(" ") : body.join("\n");
    return m[2] === "-" ? text : text + "\n";
  }

  /**
   * Fold a multi-line flow scalar (plain or quoted) whose continuation lines
   * are indented deeper than `parentIndent`, as kustomize emits long values:
   * line breaks become one space, an empty line becomes "\n", and a
   * double-quoted line ending in an escaped break (`\`) joins with nothing.
   */
  private foldContinuation(first: string, parentIndent: number): string {
    let text = first.trimEnd();
    let pendingNewlines = 0;
    let j = this.i;
    while (j < this.lines.length) {
      const l = this.lines[j]!;
      if (l.raw.trim() === "") {
        pendingNewlines++;
        j++;
        continue;
      }
      if (l.indent <= parentIndent || l.text.startsWith("#")) break;
      if (pendingNewlines > 0) text += "\n".repeat(pendingNewlines);
      else if (text.startsWith('"') && /(^|[^\\])(\\\\)*\\$/.test(text)) text = text.slice(0, -1);
      else text += " ";
      text += l.text;
      pendingNewlines = 0;
      this.i = ++j;
    }
    return text;
  }
}

/** Parse every document in a (multi-document) YAML stream. */
export function parseYamlDocs(yaml: string): Yaml[] {
  return yaml
    .split(/^---[^\S\n]*$/m)
    .map((doc) =>
      doc.split("\n").map((raw): Line => {
        const text = raw.trimStart();
        return { indent: raw.length - text.length, text: text.trimEnd(), raw };
      }),
    )
    .filter((lines) => lines.some((l) => !isBlank(l.raw)))
    .map((lines) => new Reader(lines).parseNode(0));
}

// ---------------------------------------------------------------------------
// Typed-enough access to rendered Kubernetes objects.

export interface K8sObject {
  apiVersion: string;
  kind: string;
  metadata: { name: string; namespace?: string; annotations?: Record<string, string>; labels?: Record<string, string> };
  [key: string]: any;
}

let rendered: K8sObject[] | undefined;
export const renderObjects = (): K8sObject[] => (rendered ??= parseYamlDocs(kustomizeBuild()) as unknown as K8sObject[]);

export function findObject(kind: string, name: string): K8sObject {
  const obj = renderObjects().find((o) => o.kind === kind && o.metadata?.name === name);
  if (!obj) throw new Error(`rendered manifests have no ${kind}/${name}`);
  return obj;
}
