// The `rank` operation (SPEC A2.8, A3): a saved, reproducible Ranked View over
// one corpus under one Policy version, citing the exact Score events used.
//
// Each active Item with a live Score under the version contributes its latest
// Score (greatest `scored_at`; a tie goes to the one recorded later). Entries
// are ordered by composite, then by the Policy's tie-break dimensions, then by
// item id so the order is fully determined.
import { composite, KernelError, type RankerKernel, type ScoreEvent } from "../kernel/index.ts";
import type { CorpusStore } from "../import/jsonl-importer.ts";

export interface RankedViewEntry {
  item_id: string;
  rank: number;
  composite: number;
  score_event_ids: string[];
}

export interface RankedViewActionEvent {
  item_id: string;
  action_type: "picked" | "promoted" | "pursued" | "rejected";
  actor: string;
  at: string;
}

/** SPEC A2.8 Ranked View, as defined by contracts/schemas/v1/ranked-view.schema.json. */
export interface RankedView {
  id: string;
  name: string;
  corpus_id: string;
  policy_id: string;
  policy_version: number;
  query: { subject: string };
  entries: RankedViewEntry[];
  computed_at: string;
  stale: boolean;
  stale_reason: string | null;
  action_events: RankedViewActionEvent[];
}

export interface RankInput {
  id: string;
  name: string;
  corpus_id: string;
  policy_id: string;
  policy_version: number;
  /** Subject only for now: filters and vector queries are not applied yet, so they are not accepted. */
  query: { subject: string };
  /** Keep the top N entries; all by default. */
  n?: number;
  computed_at: string;
}

const byScoredAt = (a: ScoreEvent, b: ScoreEvent) => Date.parse(a.scored_at) - Date.parse(b.scored_at);

export function rank(kernel: RankerKernel, store: CorpusStore, input: RankInput): RankedView {
  const policy = kernel.getPolicy(input.policy_id, input.policy_version);
  if (!policy) throw new KernelError("policy_version_not_found", `policy ${input.policy_id} has no version ${input.policy_version}`);
  if (policy.corpus_id !== input.corpus_id) {
    throw new KernelError("corpus_mismatch", `policy ${input.policy_id} belongs to corpus ${policy.corpus_id}, not ${input.corpus_id}`);
  }

  // liveScores is in recording order, so `>= 0` lets a later-recorded tie win.
  const latest = new Map<string, ScoreEvent>();
  for (const s of kernel.liveScores({ policy_id: input.policy_id, policy_version: input.policy_version })) {
    const prev = latest.get(s.item_id);
    if (prev === undefined || byScoredAt(s, prev) >= 0) latest.set(s.item_id, s);
  }

  const value = (s: ScoreEvent, dim: string) => s.dimension_scores.find((d) => d.dimension === dim)?.value ?? -Infinity;
  const candidates = [...latest.values()]
    .filter((s) => {
      const item = store.item(s.item_id);
      return item !== undefined && item.corpus_id === input.corpus_id && item.status === "active";
    })
    .map((s) => ({ score: s, composite: composite(policy, s.dimension_scores) }));
  candidates.sort((a, b) => {
    if (a.composite !== b.composite) return b.composite - a.composite;
    for (const dim of policy.composite_rule.tie_breaks) {
      const d = value(b.score, dim) - value(a.score, dim);
      if (d !== 0) return d;
    }
    return a.score.item_id < b.score.item_id ? -1 : a.score.item_id > b.score.item_id ? 1 : 0;
  });

  const kept = input.n === undefined ? candidates : candidates.slice(0, input.n);
  return {
    id: input.id,
    name: input.name,
    corpus_id: input.corpus_id,
    policy_id: input.policy_id,
    policy_version: input.policy_version,
    query: { subject: input.query.subject },
    entries: kept.map((c, i) => ({ item_id: c.score.item_id, rank: i + 1, composite: c.composite, score_event_ids: [c.score.id] })),
    computed_at: input.computed_at,
    stale: false,
    stale_reason: null,
    action_events: [],
  };
}
