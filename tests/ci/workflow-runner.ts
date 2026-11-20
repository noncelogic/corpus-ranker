// A small local GitHub Actions runner for the CI workflow tests. It runs the
// workflow files in .github/workflows as written, for one event, the way the
// hosted service does for the parts these workflows use:
//
//   - trigger matching (`on: push` with `branches`, `on: pull_request`);
//   - job ordering by `needs`, job and step `if:` expressions, including the
//     status functions success(), failure(), always() and cancelled() (an
//     `if:` without one is implicitly `success() && ...`), and the needs
//     context as `needs.<id>.result` and `join(needs.*.result, '<sep>')`;
//   - workflow/job/step `env:` and `${{ vars.* | secrets.* | github.* }}`
//     substitution in env values and `run:` scripts; every `secrets.*` read
//     is reported to the caller (onSecretRead);
//   - GITHUB_* defaults (GITHUB_WORKFLOW, GITHUB_JOB, ...), RUNNER_TEMP, and the OIDC request variables
//     (ACTIONS_ID_TOKEN_REQUEST_URL/TOKEN), which are exposed only to a job
//     whose effective permissions grant `id-token: write`;
//   - `run:` steps written to a file and run with `bash -e <file>` from the
//     workspace, stopping the job at the first failing step;
//   - `uses:` steps through explicit handlers: checkout is a no-op (the
//     workspace is already the checkout) and setup-node puts this process's
//     node first on PATH for the job's later steps; an unknown action or an
//     unsupported expression is an error, never skipped;
//   - the tool images: a GitHub-hosted job (ubuntu-latest) has node
//     preinstalled, but a `self-hosted` job runs on the estate runner image,
//     which has none, so there `node` is "command not found" (exit 127) until
//     a setup-node step installs it (red main 44693705144..44824828516: every
//     publish since CR-PUBLISH-OIDC died with `node: command not found`).
//
// The workflows are read with the repository's dependency-free YAML reader
// (tests/deploy/render.ts; docs/EXTERNAL-REVIEW.md §3). External commands
// (docker, npm, ...) are whatever the caller puts first on PATH.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  /** Called with the name of every `secrets.<name>` an expression reads (a credential-access record). */
  onSecretRead?: (name: string) => void;
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
  onSecretRead?: (name: string) => void;
  /** Results of the current job's direct needs, by job id, in `needs:` order. */
  needs?: Record<string, string>;
  /** What success() and failure() return where the expression is evaluated. */
  status?: { success: boolean; failure: boolean };
}

/** The function calls the expression subset accepts; any other parenthesis is refused. */
const CALL = /\b(?:always|success|failure|cancelled)\(\)|\bjoin\(\s*needs\.\*\.result\s*,\s*'(?:[^']|'')*'\s*\)/g;
const STATUS_CALL = /\b(?:always|success|failure|cancelled)\(\)/;

function operand(raw: string, ctx: Context): string | boolean {
  const s = raw.trim();
  let m: RegExpExecArray | null;
  if ((m = /^'((?:[^']|'')*)'$/.exec(s))) return m[1]!.replace(/''/g, "'");
  if (s === "true" || s === "false") return s === "true";
  if ((m = /^vars\.([A-Za-z_]\w*)$/.exec(s))) return ctx.vars[m[1]!] ?? "";
  if ((m = /^secrets\.([A-Za-z_]\w*)$/.exec(s))) {
    ctx.onSecretRead?.(m[1]!);
    return ctx.secrets[m[1]!] ?? "";
  }
  const github: Record<string, string> = {
    "github.event_name": ctx.event.name,
    "github.ref": ctx.event.ref,
    "github.sha": ctx.event.sha,
    "github.repository": ctx.repository,
  };
  if (s in github) return github[s]!;
  if (s === "always()") return true;
  if (s === "cancelled()") return false;
  if (s === "success()" || s === "failure()") {
    if (!ctx.status) throw new Error(`${s} is not available here`);
    return s === "success()" ? ctx.status.success : ctx.status.failure;
  }
  if ((m = /^needs\.([A-Za-z_][\w-]*)\.result$/.exec(s))) {
    if (!ctx.needs || !(m[1]! in ctx.needs)) throw new Error(`unknown need in expression: ${s}`);
    return ctx.needs[m[1]!]!;
  }
  if ((m = /^join\(\s*needs\.\*\.result\s*,\s*'((?:[^']|'')*)'\s*\)$/.exec(s))) {
    if (!ctx.needs) throw new Error(`${s} is not available here`);
    return Object.values(ctx.needs).join(m[1]!.replace(/''/g, "'"));
  }
  throw new Error(`unsupported expression operand: ${s}`);
}

/** Evaluate the expression subset these workflows use: ||, &&, !, ==, !=, literals, contexts and the calls in CALL. */
export function evaluate(expr: string, ctx: Context): string | boolean {
  const e = expr.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, "$1").trim();
  const bare = e.replace(CALL, "");
  if (bare.includes("(") || bare.includes(")")) throw new Error(`unsupported expression: ${e}`);
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

/** An `if:` as GitHub runs it: without a status function it is `success() && (<if>)`. */
function condition(expr: Yaml | undefined, ctx: Context): boolean {
  const text = expr === undefined ? "" : String(expr);
  if (!STATUS_CALL.test(text)) return ctx.status!.success && (expr === undefined || truthy(evaluate(text, ctx)));
  return truthy(evaluate(text, ctx));
}

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

const NOOP_ACTIONS = new Set(["actions/checkout"]);
const SETUP_NODE = "actions/setup-node";

/** Whether `runs-on` selects a self-hosted runner (a "self-hosted" label). */
export function isSelfHosted(runsOn: Yaml | undefined): boolean {
  const labels = Array.isArray(runsOn) ? runsOn.map(String) : runsOn === undefined || runsOn === null ? [] : [String(runsOn)];
  return labels.includes("self-hosted");
}

/** A directory whose `node` behaves like a runner image without node: bash's "command not found", exit 127. */
function nodeAbsent(tmp: string): string {
  const dir = join(tmp, "no-node");
  mkdirSync(dir);
  writeFileSync(join(dir, "node"), '#!/bin/bash\necho "node: command not found" >&2\nexit 127\n', { mode: 0o755 });
  return dir;
}

/**
 * What setup-node adds to PATH, as far as these workflows use it: this
 * process's node, alone in its own directory, so the caller's stand-ins
 * (npm, docker, ...) still come first for everything else.
 */
function nodeInstalled(tmp: string): string {
  const dir = join(tmp, "setup-node");
  if (!existsSync(dir)) {
    mkdirSync(dir);
    symlinkSync(process.execPath, join(dir, "node"));
  }
  return dir;
}

/** Run every job of every workflow the event triggers; returns each job's outcome (skipped jobs included). */
export async function runEvent(opts: RunnerOptions): Promise<JobRun[]> {
  const ctx: Context = {
    event: opts.event,
    repository: opts.repository,
    vars: opts.vars ?? {},
    secrets: opts.secrets ?? {},
    onSecretRead: opts.onSecretRead,
  };
  const files = opts.workflows ?? readdirSync(opts.workflowsDir).filter((f) => /\.ya?ml$/.test(f)).sort();
  const runs: JobRun[] = [];
  for (const file of files) {
    const workflow = readWorkflow(join(opts.workflowsDir, file));
    if (!triggers(workflow, opts.event)) continue;
    if (!isMap(workflow.jobs)) throw new Error(`${file}: no jobs`);
    const done = new Map<string, JobRun["status"]>();
    /** Each finished job's ancestors' statuses, itself included (success()/failure() look at the whole chain). */
    const chains = new Map<string, JobRun["status"][]>();
    const pending = Object.entries(workflow.jobs);
    while (pending.length > 0) {
      const at = pending.findIndex(([, job]) => needsOf(isMap(job) ? job : {}).every((n) => done.has(n)));
      if (at < 0) throw new Error(`${file}: unsatisfiable needs`);
      const [id, job] = pending.splice(at, 1)[0]!;
      if (!isMap(job)) throw new Error(`${file}: job ${id} is not a map`);
      const run = await runJob(file, workflow, id, job, done, chains, ctx, opts);
      done.set(id, run.status);
      chains.set(id, [run.status, ...needsOf(job).flatMap((n) => chains.get(n)!)]);
      runs.push(run);
    }
  }
  return runs;
}

function needsOf(job: Map_): string[] {
  const needs = job.needs;
  return needs === undefined || needs === null ? [] : Array.isArray(needs) ? needs.map(String) : [String(needs)];
}

async function runJob(
  file: string,
  workflow: Map_,
  id: string,
  job: Map_,
  done: Map<string, JobRun["status"]>,
  chains: Map<string, JobRun["status"][]>,
  workflowCtx: Context,
  opts: RunnerOptions,
): Promise<JobRun> {
  const permissions = job.permissions !== undefined ? job.permissions : workflow.permissions;
  const oidcOffered = grantsIdToken(permissions) && opts.oidc !== undefined;
  const run: JobRun = { workflow: file, job: id, runsOn: job["runs-on"] ?? null, permissions: permissions ?? null, status: "skipped", oidcOffered, steps: [] };
  const needs = needsOf(job);
  const ancestors = needs.flatMap((n) => chains.get(n)!);
  const jobStatus = { success: ancestors.every((s) => s === "success"), failure: ancestors.includes("failure") };
  const needResults = Object.fromEntries(needs.map((n) => [n, done.get(n)!]));
  const ctx: Context = { ...workflowCtx, needs: needResults, status: jobStatus };
  if (!condition(job.if, ctx)) return run;

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
      GITHUB_WORKFLOW: String(workflow.name ?? file),
      GITHUB_JOB: id,
      GITHUB_WORKSPACE: opts.workspace,
      RUNNER_TEMP: runnerTemp,
      ...(oidcOffered ? { ACTIONS_ID_TOKEN_REQUEST_URL: opts.oidc!.url, ACTIONS_ID_TOKEN_REQUEST_TOKEN: opts.oidc!.token } : {}),
      ...envOf(workflow.env, ctx),
      ...envOf(job.env, ctx),
    };
    if (isSelfHosted(job["runs-on"])) base.PATH = `${nodeAbsent(tmp)}:${base.PATH ?? ""}`;
    run.status = "success";
    const steps = Array.isArray(job.steps) ? job.steps : [];
    for (const [i, step] of steps.entries()) {
      if (!isMap(step)) throw new Error(`${file}: ${id} step ${i} is not a map`);
      const name = String(step.name ?? step.uses ?? step.run ?? `step ${i}`);
      const stepCtx: Context = { ...ctx, status: { success: run.status !== "failure", failure: run.status === "failure" } };
      if (!condition(step.if, stepCtx)) {
        run.steps.push({ name, status: "skipped", output: "" });
        continue;
      }
      if (step.uses !== undefined) {
        const action = String(step.uses).replace(/@.*$/, "");
        if (action === SETUP_NODE) base.PATH = `${nodeInstalled(tmp)}:${base.PATH ?? ""}`;
        else if (!NOOP_ACTIONS.has(action)) throw new Error(`${file}: ${id} uses ${action}, which this runner does not emulate`);
        run.steps.push({ name, status: "success", output: "" });
        continue;
      }
      if (typeof step.run !== "string") throw new Error(`${file}: ${id} step ${name} has neither run nor uses`);
      if (step.shell !== undefined) throw new Error(`${file}: ${id} step ${name}: shell is not emulated`);
      const env = { ...base, ...envOf(step.env, stepCtx) };
      const [status, output] = await runScript(substitute(step.run, stepCtx), opts.workspace, env, tmp);
      const ok = status === 0;
      run.steps.push({ name, status: ok ? "success" : "failure", output });
      if (!ok) run.status = "failure";
    }
    return run;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
