// The existing paper rubric (Relevance + Technical Merit, each 1–5) encoded as
// Policy `paper-rubric` v1 (SPEC §A7 Phase 0, A2.6). Historical scores in the
// weekly JSONL corpus are imported under this version.
import type { Policy } from "../kernel/index.ts";

export const PAPER_RUBRIC_ID = "cr_pol_paper";
export const PAPER_RUBRIC_NAME = "paper-rubric";

export interface PaperRubricOptions {
  corpusId: string;
  createdBy: string;
  createdAt: string;
  /** Who may score under v1; defaults to the scorers of the existing corpus (Joe and the paper judge). */
  allowedScorers?: Policy["judge_config"]["allowed_scorers"];
}

export function paperRubricV1(opts: PaperRubricOptions): Policy {
  return {
    id: PAPER_RUBRIC_ID,
    name: PAPER_RUBRIC_NAME,
    corpus_id: opts.corpusId,
    version: 1,
    dimensions: [
      {
        name: "Relevance",
        scale: { kind: "integer", min: 1, max: 5 },
        definition: {
          "1": "Not relevant to Joe's work or interests.",
          "2": "Tangential: shares a field but not a question Joe is working on.",
          "3": "Somewhat relevant: useful background for current work.",
          "4": "Relevant: bears on a problem Joe is actively working on.",
          "5": "Directly on Joe's current work.",
        },
        weight: 1,
        judge_instructions: "Score Relevance from the abstract and full text: how directly the paper bears on Joe's current work.",
      },
      {
        name: "Technical Merit",
        scale: { kind: "integer", min: 1, max: 5 },
        definition: {
          "1": "Unsound: claims unsupported or method broken.",
          "2": "Weak: thin evaluation or major gaps.",
          "3": "Adequate: sound method, ordinary evaluation.",
          "4": "Strong: careful method and evaluation.",
          "5": "Excellent: rigorous, well-evaluated and reproducible.",
        },
        weight: 1,
        judge_instructions: "Score Technical Merit from the abstract and full text: soundness of method, evaluation and reproducibility.",
      },
    ],
    judge_config: {
      allowed_scorers: opts.allowedScorers ?? [
        { kind: "human", identity: "joe" },
        { kind: "llm_judge", identity: "program:paper-judge" },
      ],
      source_blind: false,
    },
    composite_rule: { method: "weighted_sum", tie_breaks: ["Relevance", "Technical Merit"] },
    created_by: opts.createdBy,
    created_at: opts.createdAt,
    supersedes_version: null,
  };
}
