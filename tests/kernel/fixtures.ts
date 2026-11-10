// Shared fixtures for the policy + score kernel tests: the contract example
// policies (paper-rubric v1/v2) and a minimal valid score input.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contractsRoot } from "../../src/contracts/index.ts";
import type { Policy, ScoreInput } from "../../src/kernel/index.ts";

export function examplePolicy(version: 1 | 2): Policy {
  const file = join(contractsRoot, "examples", "v1", "policy", "valid", `paper-rubric-v${version}.json`);
  return JSON.parse(readFileSync(file, "utf8")) as Policy;
}

export function scoreInput(overrides: Partial<ScoreInput> = {}): ScoreInput {
  return {
    item_id: "cr_item_p0001",
    policy_id: "cr_pol_paper",
    policy_version: 1,
    dimension_scores: [
      { dimension: "Relevance", value: 5, reason: "Directly on agent context management.", evidence: [] },
      { dimension: "Technical Merit", value: 4, reason: "Careful ablations.", evidence: [] },
    ],
    scorer: { identity: "joe" },
    source_blind: false,
    ...overrides,
  };
}

/** A clock that advances one second per call, so event times are distinct and deterministic. */
export function fakeClock(start = "2026-11-10T00:00:00Z"): () => Date {
  let t = Date.parse(start);
  return () => new Date((t += 1000));
}
