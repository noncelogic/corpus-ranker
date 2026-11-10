// Policy + score kernel (SPEC A2.6, A2.7, A3 `score` / `retract_score` / `replay`, A4).
//
// The kernel is an append-only event log. Policy versions and Score events are
// only ever appended; a retraction is a new event that names the Score it
// retracts, and the contract-shaped Score (with `retracted_*` fields) is a
// derivation of the log. Nothing recorded is ever edited or removed.
//
// Storage is in memory for now; the Postgres system of record (TECH-STACK §2)
// will persist the same events with the same rules.
import { randomUUID } from "node:crypto";
import { loadContracts, schemaUri, type SchemaRegistry, type ValidationError } from "../contracts/index.ts";

export interface PolicyDimension {
  name: string;
  scale: { kind: "integer" | "number"; min: number; max: number };
  definition: Record<string, string>;
  weight: number;
  judge_instructions: string;
}

export interface Policy {
  id: string;
  name: string;
  corpus_id: string;
  version: number;
  dimensions: PolicyDimension[];
  judge_config: {
    allowed_scorers: { kind: "human" | "program" | "llm_judge"; identity: string; config?: Record<string, unknown> }[];
    source_blind: boolean;
  };
  composite_rule: { method: "weighted_sum" | "weighted_mean"; tie_breaks: string[] };
  created_by: string;
  created_at: string;
  supersedes_version: number | null;
}

export interface EvidenceRef {
  id: string;
  span?: Record<string, unknown>;
}

export interface DimensionScore {
  dimension: string;
  value: number;
  reason: string;
  evidence: EvidenceRef[];
}

export interface Scorer {
  identity: string;
  model?: string;
  config?: Record<string, unknown>;
}

/** Inputs of the `score` operation (SPEC A3). */
export interface ScoreInput {
  item_id: string;
  policy_id: string;
  policy_version: number;
  dimension_scores: DimensionScore[];
  scorer: Scorer;
  source_blind: boolean;
}

/** A Score event as the contract (score-event.schema.json) describes it. */
export interface ScoreEvent extends ScoreInput {
  id: string;
  scored_at: string;
  retracted_at: string | null;
  retracted_by: string | null;
  retraction_reason: string | null;
}

type PolicyCreatedBody = { type: "policy_created"; at: string; policy: Policy };
type ScoreRecordedBody = { type: "score_recorded"; at: string; score: ScoreEvent };
type ScoreRetractedBody = { type: "score_retracted"; at: string; score_event_id: string; reason: string; actor: string };
type KernelEventBody = PolicyCreatedBody | ScoreRecordedBody | ScoreRetractedBody;

/** One entry of the append-only log; `seq` is its 1-based position. */
export type KernelEvent = KernelEventBody & { seq: number };

export type KernelErrorCode =
  | "invalid_policy"
  | "invalid_policy_version"
  | "policy_not_found"
  | "policy_version_not_found"
  | "invalid_score"
  | "scorer_not_allowed"
  | "score_not_found"
  | "already_retracted"
  | "invalid_retraction"
  | "corpus_mismatch"
  | "invalid_replay";

export class KernelError extends Error {
  readonly code: KernelErrorCode;
  readonly details: unknown;
  constructor(code: KernelErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "KernelError";
    this.code = code;
    this.details = details;
  }
}

export interface ReplayInput {
  policy_id: string;
  from_version: number;
  to_version: number;
  corpus_id: string;
  /** Identity the replayed scores are recorded under; must be allowed by the target version. */
  scorer: Scorer;
  source_blind?: boolean;
  /**
   * Re-scores one item under the target version from its prior live Score.
   * Defaults to carrying the prior dimension scores forward, which re-derives
   * composites under the new weights / composite rule.
   */
  rescore?: (prior: ScoreEvent, target: Policy) => DimensionScore[];
}

export interface ReplayDiffEntry {
  item_id: string;
  from_composite: number;
  to_composite: number;
  delta: number;
  from_rank: number;
  to_rank: number;
  /** Positive = moved up. */
  rank_change: number;
}

export interface ReplayResult {
  policy_id: string;
  from_version: number;
  to_version: number;
  score_events: ScoreEvent[];
  diff: ReplayDiffEntry[];
}

export interface KernelOptions {
  now?: () => Date;
  newId?: () => string;
  registry?: SchemaRegistry;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function frozenCopy<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function describe(errors: ValidationError[]): string {
  return errors.map((e) => `${e.instancePath || "/"}: ${e.message}`).join("; ");
}

/** Composite of one Score under a Policy version's composite rule (data, not code). */
export function composite(policy: Policy, dimensionScores: readonly DimensionScore[]): number {
  let sum = 0;
  let weights = 0;
  for (const d of policy.dimensions) {
    const s = dimensionScores.find((x) => x.dimension === d.name);
    if (!s) continue;
    sum += d.weight * s.value;
    weights += d.weight;
  }
  if (policy.composite_rule.method === "weighted_mean") return weights === 0 ? 0 : sum / weights;
  return sum;
}

export class RankerKernel {
  readonly #log: KernelEvent[] = [];
  readonly #policies = new Map<string, Map<number, Policy>>();
  readonly #scores = new Map<string, ScoreEvent>();
  readonly #retractions = new Map<string, ScoreRetractedBody>();
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #registry: SchemaRegistry;

  constructor(options: KernelOptions = {}) {
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? (() => `cr_score_${randomUUID().replaceAll("-", "")}`);
    this.#registry = options.registry ?? loadContracts().registry;
  }

  /** The full, ordered event log. Entries are frozen; the array is a copy. */
  events(): KernelEvent[] {
    return [...this.#log];
  }

  #append<B extends KernelEventBody>(body: B): B & { seq: number } {
    const full = deepFreeze({ seq: this.#log.length + 1, ...body });
    this.#log.push(full);
    return full;
  }

  #timestamp(): string {
    return this.#now().toISOString().replace(/\.\d{3}Z$/, "Z");
  }

  // ---- Policies --------------------------------------------------------

  /** Records a new Policy version. Versions start at 1 and grow by one; an existing version is never replaced. */
  createPolicy(policy: Policy): Policy {
    const errors = this.#registry.validate(policy, schemaUri("policy.schema.json"));
    if (errors.length) throw new KernelError("invalid_policy", `policy does not match the contract: ${describe(errors)}`, errors);
    const names = policy.dimensions.map((d) => d.name);
    if (new Set(names).size !== names.length) throw new KernelError("invalid_policy", "dimension names must be unique");
    for (const d of policy.dimensions) {
      if (d.scale.min > d.scale.max) throw new KernelError("invalid_policy", `dimension ${d.name}: scale min exceeds max`);
    }

    const versions = this.#policies.get(policy.id);
    const latest = versions ? Math.max(...versions.keys()) : 0;
    if (policy.version !== latest + 1) {
      throw new KernelError(
        "invalid_policy_version",
        `policy ${policy.id} version ${policy.version} rejected: next version must be ${latest + 1}`,
      );
    }
    const expectedSupersedes = latest === 0 ? null : latest;
    if (policy.supersedes_version !== expectedSupersedes) {
      throw new KernelError("invalid_policy_version", `policy ${policy.id} v${policy.version} must supersede ${expectedSupersedes}`);
    }
    if (versions) {
      const first = versions.get(1)!;
      if (first.corpus_id !== policy.corpus_id) {
        throw new KernelError("invalid_policy", `policy ${policy.id} belongs to corpus ${first.corpus_id}`);
      }
    }

    const stored = frozenCopy(policy);
    this.#append({ type: "policy_created", at: this.#timestamp(), policy: stored });
    (versions ?? this.#policies.set(policy.id, new Map()).get(policy.id)!).set(stored.version, stored);
    return stored;
  }

  getPolicy(policyId: string, version: number): Policy | undefined {
    return this.#policies.get(policyId)?.get(version);
  }

  listPolicyVersions(policyId: string): number[] {
    return [...(this.#policies.get(policyId)?.keys() ?? [])].sort((a, b) => a - b);
  }

  #requirePolicy(policyId: string, version: number): Policy {
    const versions = this.#policies.get(policyId);
    if (!versions) throw new KernelError("policy_not_found", `policy ${policyId} does not exist`);
    const policy = versions.get(version);
    if (!policy) throw new KernelError("policy_version_not_found", `policy ${policyId} has no version ${version}`);
    return policy;
  }

  // ---- Scores ----------------------------------------------------------

  /** `score`: records one Score event against an existing Policy version. */
  score(input: ScoreInput): ScoreEvent {
    return this.#record(this.#checkScore(input));
  }

  /** Validates a score against the contract and its cited Policy version; returns it with no id or time yet. */
  #checkScore(input: ScoreInput): ScoreInput {
    const policy = this.#requirePolicy(input.policy_id, input.policy_version);

    // Only the operation's own inputs are carried; the id and times are assigned on record.
    const fields: ScoreInput = {
      item_id: input.item_id,
      policy_id: input.policy_id,
      policy_version: input.policy_version,
      dimension_scores: input.dimension_scores,
      scorer: input.scorer,
      source_blind: input.source_blind,
    };
    const event: ScoreEvent = {
      id: "cr_score_unassigned",
      ...fields,
      scored_at: "1970-01-01T00:00:00Z",
      retracted_at: null,
      retracted_by: null,
      retraction_reason: null,
    };
    const errors = this.#registry.validate(event, schemaUri("score-event.schema.json"));
    if (errors.length) throw new KernelError("invalid_score", `score does not match the contract: ${describe(errors)}`, errors);

    const seen = new Set<string>();
    for (const s of input.dimension_scores) {
      const dim = policy.dimensions.find((d) => d.name === s.dimension);
      if (!dim) throw new KernelError("invalid_score", `dimension ${s.dimension} is not in ${policy.id} v${policy.version}`);
      if (seen.has(s.dimension)) throw new KernelError("invalid_score", `dimension ${s.dimension} scored twice`);
      seen.add(s.dimension);
      if (s.value < dim.scale.min || s.value > dim.scale.max) {
        throw new KernelError("invalid_score", `dimension ${s.dimension}: ${s.value} outside ${dim.scale.min}..${dim.scale.max}`);
      }
      if (dim.scale.kind === "integer" && !Number.isInteger(s.value)) {
        throw new KernelError("invalid_score", `dimension ${s.dimension}: ${s.value} is not an integer`);
      }
    }
    if (!policy.judge_config.allowed_scorers.some((a) => a.identity === input.scorer.identity)) {
      throw new KernelError("scorer_not_allowed", `${input.scorer.identity} may not score under ${policy.id} v${policy.version}`);
    }
    return structuredClone(fields);
  }

  #record(input: ScoreInput): ScoreEvent {
    const id = this.#newId();
    if (this.#scores.has(id)) throw new KernelError("invalid_score", `score id ${id} already recorded`);
    const stored = frozenCopy<ScoreEvent>({
      id,
      ...input,
      scored_at: this.#timestamp(),
      retracted_at: null,
      retracted_by: null,
      retraction_reason: null,
    });
    this.#append({ type: "score_recorded", at: stored.scored_at, score: stored });
    this.#scores.set(stored.id, stored);
    return this.getScore(stored.id)!;
  }

  /** `retract_score`: appends a retraction event naming the Score; the Score itself stays recorded. */
  retractScore(input: { score_event_id: string; reason: string; actor: string }): ScoreEvent {
    if (!this.#scores.has(input.score_event_id)) throw new KernelError("score_not_found", `score ${input.score_event_id} does not exist`);
    if (this.#retractions.has(input.score_event_id)) {
      throw new KernelError("already_retracted", `score ${input.score_event_id} is already retracted`);
    }
    if (typeof input.reason !== "string" || input.reason.trim() === "") {
      throw new KernelError("invalid_retraction", "a retraction requires a reason");
    }
    const at = this.#timestamp();
    const candidate = { ...this.#scores.get(input.score_event_id)!, retracted_at: at, retracted_by: input.actor, retraction_reason: input.reason };
    const errors = this.#registry.validate(candidate, schemaUri("score-event.schema.json"));
    if (errors.length) throw new KernelError("invalid_retraction", `retraction does not match the contract: ${describe(errors)}`, errors);

    const event = this.#append({
      type: "score_retracted",
      at,
      score_event_id: input.score_event_id,
      reason: input.reason,
      actor: input.actor,
    });
    this.#retractions.set(input.score_event_id, event);
    return this.getScore(input.score_event_id)!;
  }

  /** The contract view of one Score: the recorded event plus its retraction, if any. */
  getScore(id: string): ScoreEvent | undefined {
    const recorded = this.#scores.get(id);
    if (!recorded) return undefined;
    const r = this.#retractions.get(id);
    return frozenCopy(r ? { ...recorded, retracted_at: r.at, retracted_by: r.actor, retraction_reason: r.reason } : recorded);
  }

  /** Every non-retracted Score recorded under one Policy version, in recording order. */
  liveScores(q: { policy_id: string; policy_version: number }): ScoreEvent[] {
    return [...this.#scores.values()]
      .filter((s) => s.policy_id === q.policy_id && s.policy_version === q.policy_version && !this.#retractions.has(s.id))
      .map((s) => this.getScore(s.id)!);
  }

  // ---- Replay ----------------------------------------------------------

  /**
   * `replay`: re-scores every item with a live Score under `from_version` as new
   * Score events under `to_version`. Prior events are never touched.
   */
  replay(input: ReplayInput): ReplayResult {
    const from = this.#requirePolicy(input.policy_id, input.from_version);
    const to = this.#requirePolicy(input.policy_id, input.to_version);
    if (input.from_version === input.to_version) throw new KernelError("invalid_replay", "replay needs two different policy versions");
    if (from.corpus_id !== input.corpus_id || to.corpus_id !== input.corpus_id) {
      throw new KernelError("corpus_mismatch", `policy ${input.policy_id} belongs to corpus ${to.corpus_id}, not ${input.corpus_id}`);
    }

    // Latest live score per item under the source version.
    const prior = new Map<string, ScoreEvent>();
    for (const s of this.liveScores({ policy_id: input.policy_id, policy_version: input.from_version })) prior.set(s.item_id, s);

    // Validate every re-score before recording any, so a failed replay appends nothing.
    const rescore = input.rescore ?? ((p: ScoreEvent) => p.dimension_scores);
    const inputs: ScoreInput[] = [...prior.values()].map((p) => ({
      item_id: p.item_id,
      policy_id: input.policy_id,
      policy_version: input.to_version,
      dimension_scores: structuredClone(rescore(p, to)),
      scorer: input.scorer,
      source_blind: input.source_blind ?? to.judge_config.source_blind,
    }));
    const checked = inputs.map((i) => this.#checkScore(i));
    const scoreEvents = checked.map((i) => this.#record(i));

    const rank = (entries: [string, number][]) =>
      new Map(
        [...entries]
          .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
          .map(([item], idx) => [item, idx + 1]),
      );
    const fromComposites = new Map([...prior.values()].map((s) => [s.item_id, composite(from, s.dimension_scores)]));
    const toComposites = new Map(scoreEvents.map((s) => [s.item_id, composite(to, s.dimension_scores)]));
    const fromRanks = rank([...fromComposites]);
    const toRanks = rank([...toComposites]);
    const diff = [...prior.keys()].map((item) => {
      const fc = fromComposites.get(item)!;
      const tc = toComposites.get(item)!;
      const fr = fromRanks.get(item)!;
      const tr = toRanks.get(item)!;
      return { item_id: item, from_composite: fc, to_composite: tc, delta: tc - fc, from_rank: fr, to_rank: tr, rank_change: fr - tr };
    });

    return { policy_id: input.policy_id, from_version: input.from_version, to_version: input.to_version, score_events: scoreEvents, diff };
  }
}
