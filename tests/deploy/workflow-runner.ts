// A small local executor for a GitHub Actions workflow file, so tests can run
// the complete workflow under a controlled event and controlled job outcomes
// instead of grepping its text.
//
// It parses the workflow with the deploy tests' YAML reader (no new
// dependency; docs/EXTERNAL-REVIEW.md §3) and then does what the Actions
// scheduler does for the subset of features it supports:
//
//   - event selection: `on` as a string, list or map; `push` and
//     `pull_request` with `branches` filters (exact names and `*`/`**` globs);
//   - scheduling: jobs run in `needs` order; an unknown need or a cycle is an
//     error;
//   - conditions: job and step `if` (default `success()`), evaluated with the
//     status functions over the job's needs and the job's earlier steps;
//   - expressions: `${{ }}` in `run` and `env`, with the `github` and `needs`
//     contexts, `*` object filters, `join`, `contains`, `startsWith`,
//     `endsWith`, `format`-free literals, `==`, `!=`, `&&`, `||`, `!`;
//   - steps: every `run` step really runs under `bash -eo pipefail` with
//     `GITHUB_JOB`, `GITHUB_EVENT_NAME`, `GITHUB_REF` and the step's `env`; a
//     `uses` step is a recorded stand-in that succeeds; a failed step fails
//     the job and later steps without `if: always()`-like conditions skip.
//
// Commands steps call resolve only against the stand-in bin directory the
// caller supplies (plus bash builtins), so an unexpected command fails the
// step loudly instead of running the real tool. Anything the executor does
// not model (matrix, services, containers, reusable workflows,
// continue-on-error, unknown functions or contexts, unsupported filters)
// throws, so a workflow change outside this subset fails the test that runs
// it rather than being silently ignored.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseYamlDocs, type Yaml } from "./render.ts";

export type Result = "success" | "failure" | "skipped" | "cancelled";

export interface WorkflowEvent {
  /** e.g. "push", "pull_request", "pull_request_target". */
  name: string;
  /** The ref the run is for: refs/heads/<branch> for push, refs/pull/<n>/merge for pull_request. */
  ref: string;
  /** For pull_request events: the base branch name. */
  baseRef?: string;
}

export interface StepRecord {
  name: string;
  kind: "run" | "uses";
  result: Result;
  stdout: string;
  stderr: string;
}

export interface JobRecord {
  id: string;
  /** The check name this job reports (its `name:` or its id). */
  checkName: string;
  needs: string[];
  result: Result;
  steps: StepRecord[];
}

export interface Run {
  triggered: boolean;
  /** Jobs in the order they ran (skipped jobs included, with result "skipped"). */
  jobs: JobRecord[];
}

type Obj = { [key: string]: Yaml };
const isObj = (v: Yaml | undefined): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export function loadWorkflow(path: string): Obj {
  const docs = parseYamlDocs(readFileSync(path, "utf8"));
  if (docs.length !== 1 || !isObj(docs[0])) throw new Error(`${path}: expected one YAML mapping`);
  return docs[0];
}

const globToRegExp = (glob: string): RegExp =>
  new RegExp(
    "^" +
      glob
        .split(/(\*\*|\*)/)
        .map((part) => (part === "**" ? ".*" : part === "*" ? "[^/]*" : part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
        .join("") +
      "$",
  );

function branchMatches(filter: Yaml, branch: string): boolean {
  const patterns = Array.isArray(filter) ? filter : [filter];
  return patterns.some((p) => {
    if (typeof p !== "string") throw new Error(`unsupported branch filter ${JSON.stringify(p)}`);
    if (p.startsWith("!")) throw new Error(`negated branch filters are not modelled: ${p}`);
    return globToRegExp(p).test(branch);
  });
}

const SUPPORTED_FILTERS = new Set(["branches", "types"]);
const DEFAULT_PR_TYPES = ["opened", "synchronize", "reopened"];

/** Whether the workflow's `on:` selects this event (as GitHub would). */
export function triggers(workflow: Obj, event: WorkflowEvent): boolean {
  const on = workflow.on;
  const selected = (name: string): Yaml | undefined | false => {
    if (typeof on === "string") return on === name ? null : false;
    if (Array.isArray(on)) return on.includes(name) ? null : false;
    if (isObj(on)) return name in on ? on[name] : false;
    throw new Error("workflow has no `on:`");
  };
  const config = selected(event.name);
  if (config === false) return false;
  if (config === null || config === undefined) return true;
  if (!isObj(config)) throw new Error(`unsupported \`on.${event.name}\`: ${JSON.stringify(config)}`);
  for (const key of Object.keys(config)) {
    if (!SUPPORTED_FILTERS.has(key)) throw new Error(`event filter on.${event.name}.${key} is not modelled`);
  }
  if (config.types !== undefined) {
    const types = Array.isArray(config.types) ? config.types : [config.types];
    if (!DEFAULT_PR_TYPES.every((t) => types.includes(t))) throw new Error(`on.${event.name}.types narrower than the default is not modelled`);
  }
  if (config.branches === undefined) return true;
  const branch =
    event.name === "push" ? event.ref.replace(/^refs\/heads\//, "") : event.baseRef ?? "";
  if (event.name === "push" && !event.ref.startsWith("refs/heads/")) return false;
  return branchMatches(config.branches, branch);
}

// ---------------------------------------------------------------------------
// Expressions.

type Value = string | number | boolean | null | Value[] | { [key: string]: Value };

interface ExprContext {
  github: { [key: string]: Value };
  needs: { [job: string]: { result: Result; outputs: { [key: string]: Value } } };
  /** Status of the job's needs (job-level `if`) or of the job so far (step `if`). */
  status: { failed: boolean; cancelled: boolean };
}

type Tok = { t: "str" | "num" | "id" | "op" | "punct"; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) i++;
    else if (c === "'") {
      let s = "";
      i++;
      for (;;) {
        if (i >= src.length) throw new Error(`unterminated string in \`${src}\``);
        if (src[i] === "'" && src[i + 1] === "'") {
          s += "'";
          i += 2;
        } else if (src[i] === "'") {
          i++;
          break;
        } else s += src[i++];
      }
      out.push({ t: "str", v: s });
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9.]+/.exec(src.slice(i))!;
      out.push({ t: "num", v: m[0] });
      i += m[0].length;
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(src.slice(i))!;
      out.push({ t: "id", v: m[0] });
      i += m[0].length;
    } else {
      const two = src.slice(i, i + 2);
      if (["==", "!=", "&&", "||", "<=", ">="].includes(two)) {
        out.push({ t: "op", v: two });
        i += 2;
      } else if ("!<>".includes(c)) {
        out.push({ t: "op", v: c });
        i++;
      } else if ("().,*[]".includes(c)) {
        out.push({ t: "punct", v: c });
        i++;
      } else throw new Error(`unexpected \`${c}\` in expression \`${src}\``);
    }
  }
  return out;
}

const truthy = (v: Value): boolean => !(v === false || v === null || v === 0 || v === "" || Number.isNaN(v));
const str = (v: Value): string => (v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
const looseEq = (a: Value, b: Value): boolean =>
  typeof a === "string" && typeof b === "string" ? a.toLowerCase() === b.toLowerCase() : a === b;

/** Evaluate one expression; also reports whether it called a status function. */
export function evaluate(src: string, ctx: ExprContext): { value: Value; usesStatus: boolean } {
  const toks = lex(src);
  let p = 0;
  let usesStatus = false;
  const peek = () => toks[p];
  const eat = (v: string) => {
    if (toks[p]?.v !== v) throw new Error(`expected \`${v}\` in \`${src}\``);
    p++;
  };

  const or = (): Value => {
    let l = and();
    while (peek()?.v === "||") {
      p++;
      const r = and();
      l = truthy(l) ? l : r;
    }
    return l;
  };
  const and = (): Value => {
    let l = cmp();
    while (peek()?.v === "&&") {
      p++;
      const r = cmp();
      l = truthy(l) ? r : l;
    }
    return l;
  };
  const cmp = (): Value => {
    let l = unary();
    while (peek()?.v === "==" || peek()?.v === "!=") {
      const op = toks[p++]!.v;
      const r = unary();
      l = op === "==" ? looseEq(l, r) : !looseEq(l, r);
    }
    return l;
  };
  const unary = (): Value => {
    if (peek()?.v === "!") {
      p++;
      return !truthy(unary());
    }
    return postfix(primary());
  };
  const postfix = (base: Value): Value => {
    let v = base;
    for (;;) {
      if (peek()?.v === ".") {
        p++;
        const k = toks[p++];
        if (k?.v === "*") {
          v = isObjV(v) ? Object.values(v) : Array.isArray(v) ? v : [];
          // A following property access maps over the filtered values.
          if (peek()?.v === ".") {
            p++;
            const prop = toks[p++]!.v;
            v = (v as Value[]).map((item) => (isObjV(item) ? item[prop] ?? null : null));
          }
        } else if (k?.t === "id") {
          v = isObjV(v) ? v[k.v] ?? null : null;
        } else throw new Error(`bad property access in \`${src}\``);
      } else if (peek()?.v === "[") {
        p++;
        const key = or();
        eat("]");
        v = isObjV(v) ? v[str(key)] ?? null : Array.isArray(v) ? v[Number(key)] ?? null : null;
      } else return v;
    }
  };
  const isObjV = (v: Value): v is { [key: string]: Value } => typeof v === "object" && v !== null && !Array.isArray(v);
  const primary = (): Value => {
    const tok = toks[p++];
    if (!tok) throw new Error(`unexpected end of \`${src}\``);
    if (tok.t === "str") return tok.v;
    if (tok.t === "num") return Number(tok.v);
    if (tok.v === "(") {
      const v = or();
      eat(")");
      return v;
    }
    if (tok.t !== "id") throw new Error(`unexpected \`${tok.v}\` in \`${src}\``);
    if (tok.v === "true") return true;
    if (tok.v === "false") return false;
    if (tok.v === "null") return null;
    if (peek()?.v === "(") {
      p++;
      const args: Value[] = [];
      while (peek()?.v !== ")") {
        args.push(or());
        if (peek()?.v === ",") p++;
      }
      eat(")");
      return call(tok.v, args);
    }
    if (tok.v === "github") return ctx.github;
    if (tok.v === "needs") return ctx.needs as unknown as Value;
    throw new Error(`context \`${tok.v}\` is not modelled (in \`${src}\`)`);
  };
  const call = (fn: string, args: Value[]): Value => {
    switch (fn) {
      case "success":
        usesStatus = true;
        return !ctx.status.failed && !ctx.status.cancelled;
      case "failure":
        usesStatus = true;
        return ctx.status.failed;
      case "cancelled":
        usesStatus = true;
        return ctx.status.cancelled;
      case "always":
        usesStatus = true;
        return true;
      case "join": {
        const [list, sep = ","] = args;
        return Array.isArray(list) ? list.map(str).join(str(sep)) : str(list ?? null);
      }
      case "contains": {
        const [hay, needle] = args;
        return Array.isArray(hay) ? hay.some((h) => looseEq(h, needle ?? null)) : str(hay ?? null).toLowerCase().includes(str(needle ?? null).toLowerCase());
      }
      case "startsWith":
        return str(args[0] ?? null).toLowerCase().startsWith(str(args[1] ?? null).toLowerCase());
      case "endsWith":
        return str(args[0] ?? null).toLowerCase().endsWith(str(args[1] ?? null).toLowerCase());
      default:
        throw new Error(`function \`${fn}\` is not modelled (in \`${src}\`)`);
    }
  };

  const value = or();
  if (p !== toks.length) throw new Error(`trailing tokens in \`${src}\``);
  return { value, usesStatus };
}

/** Substitute every `${{ }}` in a string. */
function interpolate(text: string, ctx: ExprContext): string {
  return text.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expr: string) => str(evaluate(expr.trim(), ctx).value));
}

/** An `if:` condition: GitHub wraps it in success() && (...) unless it calls a status function. */
function condition(raw: Yaml | undefined, ctx: ExprContext): boolean {
  if (raw === undefined || raw === null) return !ctx.status.failed && !ctx.status.cancelled;
  if (typeof raw === "boolean") return raw && !ctx.status.failed && !ctx.status.cancelled;
  if (typeof raw !== "string") throw new Error(`unsupported if: ${JSON.stringify(raw)}`);
  const src = raw.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1").trim();
  const { value, usesStatus } = evaluate(src, ctx);
  return usesStatus ? truthy(value) : truthy(value) && !ctx.status.failed && !ctx.status.cancelled;
}

// ---------------------------------------------------------------------------
// Running.

const WORKFLOW_KEYS = new Set(["name", "run-name", "on", "permissions", "concurrency", "env", "jobs"]);
const JOB_KEYS = new Set(["name", "needs", "if", "runs-on", "timeout-minutes", "steps", "permissions", "env"]);
const STEP_KEYS = new Set(["name", "id", "if", "run", "uses", "with", "env", "timeout-minutes", "shell"]);

export interface RunOptions {
  event: WorkflowEvent;
  /** Directory holding stand-in commands; it is the only PATH entry `run` steps see. */
  binDir: string;
  /** Extra environment for every `run` step (e.g. control knobs the stand-ins read). */
  env?: Record<string, string>;
  /** Working directory for `run` steps. */
  cwd: string;
}

const needsOf = (job: Obj, id: string): string[] => {
  const n = job.needs;
  if (n === undefined || n === null) return [];
  if (typeof n === "string") return [n];
  if (Array.isArray(n) && n.every((x): x is string => typeof x === "string")) return n;
  throw new Error(`job ${id}: unsupported needs ${JSON.stringify(n)}`);
};

/** Topological order of the jobs; throws on an unknown need or a cycle. */
function order(jobs: Obj): string[] {
  const out: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, from?: string) => {
    const job = jobs[id];
    if (!isObj(job)) throw new Error(`job ${from} needs unknown job ${id}`);
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") throw new Error(`needs cycle through ${id}`);
    state.set(id, "visiting");
    for (const n of needsOf(job, id)) visit(n, id);
    state.set(id, "done");
    out.push(id);
  };
  for (const id of Object.keys(jobs)) visit(id);
  return out;
}

/** Run the complete workflow for one event. */
export function runWorkflow(workflow: Obj, opts: RunOptions): Run {
  for (const key of Object.keys(workflow)) if (!WORKFLOW_KEYS.has(key)) throw new Error(`workflow \`${key}\` is not modelled`);
  if (!triggers(workflow, opts.event)) return { triggered: false, jobs: [] };
  const jobs = workflow.jobs;
  if (!isObj(jobs)) throw new Error("workflow has no jobs");
  const github: { [key: string]: Value } = {
    event_name: opts.event.name,
    ref: opts.event.ref,
    base_ref: opts.event.baseRef ?? "",
  };
  const results = new Map<string, JobRecord>();
  const ancestors = (id: string): string[] => {
    const seen = new Set<string>();
    const walk = (j: string) => {
      for (const n of needsOf(jobs[j] as Obj, j)) {
        if (seen.has(n)) continue;
        seen.add(n);
        walk(n);
      }
    };
    walk(id);
    return [...seen];
  };

  const run: Run = { triggered: true, jobs: [] };
  for (const id of order(jobs)) {
    const job = jobs[id] as Obj;
    for (const key of Object.keys(job)) if (!JOB_KEYS.has(key)) throw new Error(`job ${id}: \`${key}\` is not modelled`);
    if (typeof job["runs-on"] !== "string" && !Array.isArray(job["runs-on"])) throw new Error(`job ${id}: no runs-on`);
    const needs = needsOf(job, id);
    const needsCtx: ExprContext["needs"] = {};
    for (const n of needs) needsCtx[n] = { result: results.get(n)!.result, outputs: {} };
    const upstream = ancestors(id).map((a) => results.get(a)!.result);
    const jobCtx: ExprContext = {
      github,
      needs: needsCtx,
      status: { failed: upstream.includes("failure"), cancelled: upstream.includes("cancelled") },
    };
    // A needed job that did not succeed also stops a default `success()` job.
    const needsOk = needs.every((n) => results.get(n)!.result === "success");
    const rawIf = job.if;
    const usesStatus = typeof rawIf === "string" && evaluate(rawIf.replace(/^\$\{\{([\s\S]*)\}\}$/, "$1").trim(), jobCtx).usesStatus;
    const runs = condition(rawIf, jobCtx) && (usesStatus || needsOk);
    const record: JobRecord = {
      id,
      checkName: typeof job.name === "string" ? job.name : id,
      needs,
      result: "skipped",
      steps: [],
    };
    results.set(id, record);
    run.jobs.push(record);
    if (!runs) continue;

    const steps = job.steps;
    if (!Array.isArray(steps) || steps.length === 0) throw new Error(`job ${id} has no steps`);
    let failed = false;
    for (const [i, raw] of steps.entries()) {
      if (!isObj(raw)) throw new Error(`job ${id} step ${i}: not a mapping`);
      for (const key of Object.keys(raw)) if (!STEP_KEYS.has(key)) throw new Error(`job ${id} step ${i}: \`${key}\` is not modelled`);
      if (raw.shell !== undefined && raw.shell !== "bash") throw new Error(`job ${id} step ${i}: shell ${String(raw.shell)} is not modelled`);
      const stepCtx: ExprContext = { github, needs: needsCtx, status: { failed, cancelled: false } };
      const name = typeof raw.name === "string" ? raw.name : typeof raw.run === "string" ? raw.run : String(raw.uses);
      const kind = raw.run !== undefined ? "run" : "uses";
      if (!condition(raw.if, stepCtx)) {
        record.steps.push({ name, kind, result: "skipped", stdout: "", stderr: "" });
        continue;
      }
      if (kind === "uses") {
        if (typeof raw.uses !== "string" || raw.uses.startsWith("./") || raw.uses.includes(".github/workflows/")) {
          throw new Error(`job ${id} step ${i}: uses ${String(raw.uses)} is not modelled`);
        }
        record.steps.push({ name, kind, result: "success", stdout: "", stderr: "" });
        continue;
      }
      if (typeof raw.run !== "string") throw new Error(`job ${id} step ${i}: run is not a string`);
      const stepEnv: Record<string, string> = {};
      for (const scope of [workflow.env, job.env, raw.env]) {
        if (scope === undefined || scope === null) continue;
        if (!isObj(scope)) throw new Error(`job ${id} step ${i}: env is not a mapping`);
        for (const [k, v] of Object.entries(scope)) stepEnv[k] = interpolate(str(v as Value), stepCtx);
      }
      const r = spawnSync("/bin/bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", interpolate(raw.run, stepCtx)], {
        cwd: opts.cwd,
        encoding: "utf8",
        env: {
          ...opts.env,
          ...stepEnv,
          PATH: opts.binDir,
          GITHUB_JOB: id,
          GITHUB_EVENT_NAME: opts.event.name,
          GITHUB_REF: opts.event.ref,
          GITHUB_ACTIONS: "true",
          CI: "true",
        },
      });
      if (r.error) throw r.error;
      const ok = r.status === 0;
      record.steps.push({ name, kind, result: ok ? "success" : "failure", stdout: r.stdout, stderr: r.stderr });
      if (!ok) failed = true;
    }
    record.result = failed ? "failure" : "success";
  }
  return run;
}
