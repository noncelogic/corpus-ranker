// The second corpus (SPEC §A7 Phase 2): investors and funding opportunities,
// ranked under Policy `funding-fit` v1 (Fit / Timing / Deadline / Value).
// Migration 0002_funding_corpus seeds the corpus and this exact policy row;
// the funding acceptance test checks the two agree.
//
// Dimension weights are equal in v1. Changing them is a new Policy version
// that is replayed, never an edit of v1 (SPEC A3 `replay`).
import type { Policy } from "../kernel/index.ts";

export const FUNDING_CORPUS_ID = "cr_corpus_funding";
export const FUNDING_CORPUS_NAME = "funding";
export const FUNDING_TAXONOMY_ID = "cr_tax_funding1";
/** The item types of the funding corpus: a funding program (grant, fellowship, accelerator) and an investor. */
export const FUNDING_ITEM_TYPES = ["program", "investor"] as const;
export type FundingItemType = (typeof FUNDING_ITEM_TYPES)[number];

export const FUNDING_FIT_ID = "cr_pol_funding";
export const FUNDING_FIT_NAME = "funding-fit";
export const FUNDING_FIT_DIMENSIONS = ["Fit", "Timing", "Deadline", "Value"] as const;
/** When migration 0002 recorded v1. */
export const FUNDING_FIT_V1_CREATED_AT = "2026-11-16T00:00:00Z";

export function fundingFitV1(): Policy {
  return {
    id: FUNDING_FIT_ID,
    name: FUNDING_FIT_NAME,
    corpus_id: FUNDING_CORPUS_ID,
    version: 1,
    dimensions: [
      {
        name: "Fit",
        scale: { kind: "integer", min: 1, max: 5 },
        definition: {
          "1": "No fit: the program or investor does not fund work like Joe's.",
          "2": "Weak fit: adjacent field or stage, a stretch to apply.",
          "3": "Plausible fit: eligible, but not what they usually fund.",
          "4": "Good fit: funds work like Joe's at Joe's stage.",
          "5": "Direct fit: funds exactly this kind of work, stage and applicant.",
        },
        weight: 1,
        judge_instructions: "Score Fit from the program or investor's stated focus, eligibility and portfolio: how well it matches Joe's work and stage.",
      },
      {
        name: "Timing",
        scale: { kind: "integer", min: 1, max: 5 },
        definition: {
          "1": "Wrong time: Joe could not use or qualify for this now.",
          "2": "Early or late: it fits a different phase of the work.",
          "3": "Workable: the timing neither helps nor hurts.",
          "4": "Good timing: it fits where the work is now.",
          "5": "Ideal timing: it fits the work's current phase exactly.",
        },
        weight: 1,
        judge_instructions: "Score Timing from the program or investor's cycle and the work's current phase: whether now is the right moment to pursue it.",
      },
      {
        name: "Deadline",
        scale: { kind: "integer", min: 1, max: 5 },
        definition: {
          "1": "Passed or impossible: no realistic way to apply in time.",
          "2": "Very tight: applying in time would displace other work.",
          "3": "Tight but feasible: enough time with focused effort.",
          "4": "Comfortable: ample time to prepare a strong application.",
          "5": "Open: rolling intake or a deadline far enough away to prepare well.",
        },
        weight: 1,
        judge_instructions: "Score Deadline from the stated deadline or intake schedule: how much room there is to prepare a strong application.",
      },
      {
        name: "Value",
        scale: { kind: "integer", min: 1, max: 5 },
        definition: {
          "1": "Not worth the effort: the award or terms cost more than they give.",
          "2": "Low value: small relative to the effort or with heavy strings.",
          "3": "Moderate value: worth pursuing if the effort is small.",
          "4": "High value: meaningful money, access or credibility.",
          "5": "Exceptional value: changes what the work can do.",
        },
        weight: 1,
        judge_instructions: "Score Value from the amount, terms and non-financial benefits relative to the effort of applying.",
      },
    ],
    judge_config: {
      allowed_scorers: [{ kind: "human", identity: "joe" }],
      source_blind: false,
    },
    composite_rule: { method: "weighted_sum", tie_breaks: ["Fit", "Timing", "Deadline", "Value"] },
    created_by: "joe",
    created_at: FUNDING_FIT_V1_CREATED_AT,
    supersedes_version: null,
  };
}
