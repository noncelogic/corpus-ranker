// Shared by the deploy/openbao readback checkers (check-api-keys-grant.ts,
// check-eso-attach.ts): parse an OpenBao policy's path stanzas, compare a
// read-back policy with its repository file, and run the `bao` CLI. It reads
// names and policy text only, never a secret value.
//
// Public: ReadError, Grants, parsePolicy, comparePolicy, isWildcard, quote, bao.
import { spawnSync } from "node:child_process";

/** A read that failed for a reason other than "not found": the checkers exit 2. */
export class ReadError extends Error {}

/**
 * A policy's grants: path -> capabilities, plus any other stanza setting, any text that is not a path stanza, and
 * any quoted string this parser cannot decode exactly as OpenBao does.
 */
export interface Grants {
  paths: Map<string, Set<string>>;
  settings: Array<{ path: string; setting: string }>;
  unparsed: string[];
  unsupported: string[];
}

/** `bad` is set on a string token whose escapes or interpolation this parser does not decode. */
type Token = { kind: "string" | "word" | "punct"; text: string; bad?: string };

/** HCL's single-character escapes, decoded as OpenBao's policy parser (HCL 1) decodes them. */
const SIMPLE_ESCAPES: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", '"': '"' };

/**
 * Read the quoted string opening at hcl[start], decoding escapes as HCL does: the single-character escapes,
 * \uXXXX and \UXXXXXXXX. Octal and \x byte escapes, any other escape, `${` interpolation (inside which HCL does
 * not decode escapes) and an unterminated string are not decoded; they set `bad`, which the comparison reports
 * as drift rather than guess at the path OpenBao holds.
 */
function readString(hcl: string, start: number): { token: Token; end: number } {
  let s = "";
  let bad: string | undefined;
  const flag = (why: string) => {
    bad ??= why;
  };
  let i = start + 1;
  while (i < hcl.length && hcl[i] !== '"') {
    const c = hcl[i]!;
    if (c === "$" && hcl[i + 1] === "{") flag("holds ${ interpolation");
    if (c !== "\\") {
      s += c;
      i++;
      continue;
    }
    const e = hcl[i + 1];
    if (e === undefined) break;
    const simple = SIMPLE_ESCAPES[e];
    if (simple !== undefined) {
      s += simple;
      i += 2;
      continue;
    }
    const width = e === "u" ? 4 : e === "U" ? 8 : 0;
    const hex = hcl.slice(i + 2, i + 2 + width);
    const code = width && /^[0-9a-fA-F]+$/.test(hex) && hex.length === width ? parseInt(hex, 16) : undefined;
    if (code !== undefined && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
      s += String.fromCodePoint(code);
      i += 2 + width;
      continue;
    }
    flag(`holds the unsupported escape ${JSON.stringify(`\\${e}`)}`);
    s += c + e;
    i += 2;
  }
  if (i >= hcl.length) flag("is unterminated");
  return { token: { kind: "string", text: s, ...(bad ? { bad } : {}) }, end: i + 1 };
}

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
      const { token, end } = readString(hcl, i);
      tokens.push(token);
      i = end;
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
export function parsePolicy(hcl: string): Grants {
  const t = tokenize(hcl);
  const grants: Grants = { paths: new Map(), settings: [], unparsed: [], unsupported: [] };
  for (const tok of t) if (tok.bad) grants.unsupported.push(`string ${quote(tok.text)} ${tok.bad}`);
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
        grants.unparsed.push(`path ${show(path)} has no { } stanza`);
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
      else grants.unparsed.push(`path ${show(path)}: unterminated stanza`);
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

export const isWildcard = (p: string) => /[*+]/.test(p);
export const quote = (v: unknown) => JSON.stringify(v);
/** A path as printed in drift: bare when printable, JSON-quoted when it holds a control or non-ASCII character. */
const show = (p: string) => (/^[\x21-\x7e]*$/.test(p) ? p : quote(p));

export function comparePolicy(name: string, declared: Grants, read: Grants): string[] {
  const drift: string[] = [];
  const at = `policy ${name}`;
  for (const u of read.unsupported) drift.push(`${at}: cannot be compared exactly: ${u}`);
  for (const u of declared.unsupported) drift.push(`${at}: its repository file cannot be compared exactly: ${u}`);
  for (const u of read.unparsed) drift.push(`${at}: holds something other than path stanzas: ${u}`);
  for (const [path, caps] of read.paths) {
    const want = declared.paths.get(path);
    if (!want) {
      drift.push(`${at}: path ${show(path)} is not declared${isWildcard(path) ? " (wildcard)" : ""}: capabilities ${quote([...caps].sort())}`);
      continue;
    }
    for (const c of [...caps].sort()) if (!want.has(c)) drift.push(`${at}: path ${show(path)}: capability ${quote(c)} is not declared`);
    for (const c of [...want].sort()) if (!caps.has(c)) drift.push(`${at}: path ${show(path)}: capability ${quote(c)} is declared but absent`);
  }
  for (const path of declared.paths.keys()) {
    if (!read.paths.has(path)) drift.push(`${at}: path ${show(path)} is declared but absent`);
  }
  const declaredSettings = new Set(declared.settings.map((s) => `${s.path}\0${s.setting}`));
  for (const s of read.settings) {
    if (!declaredSettings.has(`${s.path}\0${s.setting}`)) drift.push(`${at}: path ${show(s.path)}: setting ${quote(s.setting)} is not declared`);
  }
  return drift;
}

/** Run `bao` (with `input` on stdin, if given); stdout on success, undefined when OpenBao says the object does not exist. */
export function bao(args: string[], notFound: RegExp, input?: string): string | undefined {
  const r = spawnSync("bao", args, { encoding: "utf8", ...(input === undefined ? { stdio: ["ignore", "pipe", "pipe"] } : { input }) });
  if (r.error) throw new ReadError(`cannot run bao: ${r.error.message}`);
  if (r.status === 0) return r.stdout;
  const err = `${r.stderr ?? ""}${r.stdout ?? ""}`.trim();
  if (notFound.test(err)) return undefined;
  throw new ReadError(`bao ${args.join(" ")} failed (exit ${r.status ?? r.signal}): ${err.split("\n")[0] ?? ""}`);
}
