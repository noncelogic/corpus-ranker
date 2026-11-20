// A small local GitHub Actions runner for the CI workflow tests. It runs the
// workflow files in .github/workflows as written, for one event, the way the
// hosted service does for the parts these workflows use:
//
//   - trigger matching (`on: push` with `branches`, `on: pull_request`);
//   - job ordering by `needs`, job and step `if:` expressions;
//   - workflow/job/step `env:` and `${{ vars.* | secrets.* | github.* }}`
//     substitution in env values and `run:` scripts;
//   - GITHUB_* defaults, RUNNER_TEMP, and the OIDC request variables
//     (ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN), which are exposed only to a job
//     whose effective permissions grant `id-token: write`;
//   - `run:` steps written to a file and run with `bash -e <file>` from the
//     workspace, stopping the job at the first failing step;
//   - `uses:` steps through explicit handlers (checkout and setup-node are
//     no-ops: the workspace is already the checkout and node is on PATH); an
//     unknown action or an unsupported expression is an error, never skipped.
//
// The workflows are read with the repository's dependency-free YAML reader
// (tests/deploy/render.ts; docs/EXTERNAL-REVIEW.md §3). External commands
// (docker, npm, ...) are whatever the caller puts first on PATH.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseYamlDocs, type Yaml } from "../deploy/render.ts";

type Map_ = { [key: string]: Yaml };

export interface WorkflowEvent {
  name: "push" | "pull_request";
  /** e.g. refs/heads/main, or refs/pull/1/merge */
  ref: string;
  sha: string;
}

export interface RunnerOptions {
  workflowsDir: string;
  /** File names to consider; default: every *.yml / *.yaml in workflowsDir. */
  workflows?: string[];
  event: WorkflowEvent;
  workspace: string;
  repository: string;
  vars?: Record<string, string>;
  secrets?: Record<string, string>;
  /** Host environment every step inherits (PATH with any stand-ins, HOME, mounts...). */
  hostEnv: Record<string, string>;
  /** The OIDC token endpoint the runner offers to jobs granted `id-token: write`. */
  oidc?: { url: string; token: string };
}

export interface StepRun {
  name: string;
  status: "success" | "failure" | "skipped";
  output: string;
}

export interface JobRun {
  workflow: string;
  job: string;
  runsOn: Yaml;
  permissions: Yaml;
  status: "success" | "failure" | "skipped";
  /** Whether the runner handed this job the OIDC request variables. */
  oidcOffered: boolean;
  steps: StepRun[];
}

const isMap = (v: Yaml | undefined): v is Map_ => typeof v === "object" && v !== null && !Array.isArray(v);

export function readWorkflow(path: string): Map_ {
  const [doc] = parseYamlDocs(readFileSync(path, "utf8"));
  if (!isMap(doc)) throw new Error(`${path}: not a YAML map`);
  return doc;
}

/** Whether `on:` of the workflow fires for the event. */
export function triggers(workflow: Map_, event: WorkflowEvent): boolean {
  const on = workflow.on ?? workflow["true"];
  const names = typeof on === "string" ? [on] : Array.isArray(on) ? on.map(String) : isMap(on) ? Object.keys(on) : [];
  if (!names.includes(event.name)) return false;
  const filter = isMap(on) ? on[event.name] : null;
  if (!isMap(filter)) return true;
  for (const key of Object.keys(filter)) {
    if (!["branches", "types"].includes(key)) throw new Error(`unsupported trigger filter ${event.name}.${key}`);
  }
  if (filter.branches === undefined) return true;
  if (event.name !== "push") throw new Error("branch filters are supported for push only");
  const branches = (Array.isArray(filter.branches) ? filter.branches : [filter.branches]).map(String);
  const branch = event.ref.replace(/^refs\/heads\//, "");
  return branches.some((b) => (b.includes("*") ? new RegExp(`^${b.replace(/\*\*?/g, ".*")}$`).test(branch) : b === branch));
}

interface Context {
  event: WorkflowEvent;
  repository: string;
  vars: Record<string, string>;
  secrets: Record<string, string>;
}

function operand(raw: string, ctx: Context): string | boolean {
  const s = raw.trim();
  let m: RegExpExecArray | null;
  if ((m = /^'((?:[^']|'')*)'$/.exec(s))) return m[1]!.replace(/''/g, "'");
  if (s === "true" || s === "false") return s === "true";
  if ((m = /^vars\.([A-Za-z_]\w*)$/.exec(s))) return ctx.vars[m[1]!] ?? "";
  if ((m = /^secrets\.([A-Za-z_]\w*)$/.exec(s))) return ctx.secrets[m[1]!] ?? "";
  const github: Record<string, string> = {
    "github.event_name": ctx.event.name,
    "github.ref": ctx.event.ref,
    "github.sha": ctx.event.sha,
    "github.repository": ctx.repository,
  };
  if (s in github) return github[s]!;
  throw new Error(`unsupported expression operand: ${s}`);
}

/** Evaluate the expression subset these workflows use: ||, &&, !, ==, !=, literals and contexts. */
export function evaluate(expr: string, ctx: Context): string | boolean {
  const e = expr.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1").trim();
  if (e.includes("(") || e.includes(")")) throw new Error(`unsupported expression: ${e}`);
  const or = e.split("||");
  if (or.length > 1) return or.some((part) => truthy(evaluate(part, ctx)));
  const and = e.split("&&");
  if (and.length > 1) return and.every((part) => truthy(evaluate(part, ctx)));
  let m: RegExpExecArray | null;
  if ((m = /^(.+?)\s*(==|!=)\s*(.+)$/.exec(e))) {
    const equal = String(operand(m[1]!, ctx)).toLowerCase() === String(operand(m[3]!, ctx)).toLowerCase();
    return m[2] === "==" ? equal : !equal;
  }
  if (e.startsWith("!")) return !truthy(evaluate(e.slice(1), ctx));
  return operand(e, ctx);
}

const truthy = (v: string | boolean): boolean => v !== false && v !== "";

function substitute(text: string, ctx: Context): string {
  return text.replace(/\$\{\{([\s\S]*?)\}\}/g, (_, expr: string) => String(evaluate(expr, ctx)));
}

function envOf(block: Yaml | undefined, ctx: Context): Record<string, string> {
  if (block === undefined || block === null) return {};
  if (!isMap(block)) throw new Error("env must be a map");
  return Object.fromEntries(Object.entries(block).map(([k, v]) => [k, substitute(String(v), ctx)]));
}

function grantsIdToken(permissions: Yaml | undefined): boolean {
  if (permissions === "write-all") return true;
  return isMap(permissions) && permissions["id-token"] === "write";
}

async function runScript(script: string, cwd: string, env: Record<string, string>, tmp: string): Promise<[number | null, string]> {
  const file = join(tmp, `step-${Math.random().toString(36).slice(2)}.sh`);
  writeFileSync(file, script);
  const child = spawn("bash", ["-e", file], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (c: Buffer) => (output += c.toString()));
  child.stderr.on("data", (c: Buffer) => (output += c.toString()));
  const [status] = (await once(child, "close")) as [number | null];
  return [status, output];
}

const NOOP_ACTIONS = new Set(["actions/checkout", "actions/setup-node"]);

/** Run every job of every workflow the event triggers; returns each job's outcome (skipped jobs included). */
export async function runEvent(opts: RunnerOptions): Promise<JobRun[]> {
  const ctx: Context = { event: opts.event, repository: opts.repository, vars: opts.vars ?? {}, secrets: opts.secrets ?? {} };
  const files = opts.workflows ?? readdirSync(opts.workflowsDir).filter((f) => /\.ya?ml$/.test(f)).sort();
  const runs: JobRun[] = [];
  for (const file of files) {
    const workflow = readWorkflow(join(opts.workflowsDir, file));
    if (!triggers(workflow, opts.event)) continue;
    if (!isMap(workflow.jobs)) throw new Error(`${file}: no jobs`);
    const done = new Map<string, JobRun["status"]>();
    const pending = Object.entries(workflow.jobs);
    while (pending.length > 0) {
      const at = pending.findIndex(([, job]) => {
        const needs = isMap(job) ? job.needs : undefined;
        const list = needs === undefined || needs === null ? [] : Array.isArray(needs) ? needs.map(String) : [String(needs)];
        return list.every((n) => done.has(n));
      });
      if (at < 0) throw new Error(`${file}: unsatisfiable needs`);
      const [id, job] = pending.splice(at, 1)[0]!;
      if (!isMap(job)) throw new Error(`${file}: job ${id} is not a map`);
      const run = await runJob(file, workflow, id, job, done, ctx, opts);
      done.set(id, run.status);
      runs.push(run);
    }
  }
  return runs;
}

async function runJob(
  file: string,
  workflow: Map_,
  id: string,
  job: Map_,
  done: Map<string, JobRun["status"]>,
  ctx: Context,
  opts: RunnerOptions,
): Promise<JobRun> {
  const permissions = job.permissions !== undefined ? job.permissions : workflow.permissions;
  const oidcOffered = grantsIdToken(permissions) && opts.oidc !== undefined;
  const run: JobRun = { workflow: file, job: id, runsOn: job["runs-on"] ?? null, permissions: permissions ?? null, status: "skipped", oidcOffered, steps: [] };
  const needs = job.needs === undefined || job.needs === null ? [] : Array.isArray(job.needs) ? job.needs.map(String) : [String(job.needs)];
  if (needs.some((n) => done.get(n) !== "success")) return run;
  if (job.if !== undefined && !truthy(evaluate(String(job.if), ctx))) return run;

  const tmp = mkdtempSync(join(tmpdir(), "gha-"));
  try {
    const runnerTemp = join(tmp, "runner-temp");
    mkdirSync(runnerTemp);
    const base: Record<string, string> = {
      ...opts.hostEnv,
      CI: "true",
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: ctx.event.name,
      GITHUB_REF: ctx.event.ref,
      GITHUB_SHA: ctx.event.sha,
      GITHUB_REPOSITORY: ctx.repository,
      GITHUB_WORKSPACE: opts.workspace,
      RUNNER_TEMP: runnerTemp,
      ...(oidcOffered ? { ACTIONS_ID_TOKEN_REQUEST_URL: opts.oidc!.url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: opts.oidc!.token } : {}),
      ...envOf(workflow.env, ctx),
      ...envOf(job.env, ctx),
    };
    run.status = "success";
    const steps = Array.isArray(job.steps) ? job.steps : [];
    for (const [i, step] of steps.entries()) {
      if (!isMap(step)) throw new Error(`${file}: ${id} step ${i} is not a map`);
      const name = String(step.name ?? step.uses ?? step.run ?? `step ${i}`);
      if (run.status === "failure" || (step.if !== undefined && !truthy(evaluate(String(step.if), ctx)))) {
        run.steps.push({ name, status: "skipped", output: "" });
        continue;
      }
      if (step.uses !== undefined) {
        const action = String(step.uses).replace(/@.*$/, "");
        if (!NOOP_ACTIONS.has(action)) throw new Error(`${file}: ${id} uses ${action}, which this runner does not emulate`);
        run.steps.push({ name, status: "success", output: "" });
        continue;
      }
      if (typeof step.run !== "string") throw new Error(`${file}: ${id} step ${name} has neither run nor uses`);
      if (step.shell !== undefined) throw new Error(`${file}: ${id} step ${name}: shell is not emulated`);
      const env = { ...base, ...envOf(step.env, ctx) };
      const [status, output] = await runScript(substitute(step.run, ctx), opts.workspace, env, tmp);
      const ok = status === 0;
      run.steps.push({ name, status: ok ? "success" : "failure", output });
      if (!ok) run.status = "failure";
    }
    return run;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
