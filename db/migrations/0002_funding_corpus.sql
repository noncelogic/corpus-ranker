-- 0002 funding corpus: the second corpus (SPEC §A7 Phase 2), investors and
-- funding opportunities, proving the model is not paper-shaped.
--
-- Seeds the corpus (item types: program, investor) and Policy funding-fit v1
-- (Fit / Timing / Deadline / Value, integer 1-5, equal weights). This row must
-- match fundingFitV1() in src/funding/funding-fit.ts; the funding acceptance
-- test checks it. Changing a weight or definition is a new Policy version that
-- is replayed, never an edit of this row.

INSERT INTO corpora (id, name, description, taxonomy_id, status)
VALUES (
  'cr_corpus_funding',
  'funding',
  'Investors and funding opportunities. Item types: program (a grant, fellowship, accelerator or other funding program) and investor.',
  'cr_tax_funding1',
  'active'
);

INSERT INTO policies (id, version, name, corpus_id, dimensions, judge_config, composite_rule,
                      created_by, created_at, supersedes_version)
VALUES (
  'cr_pol_funding', 1, 'funding-fit', 'cr_corpus_funding',
  $json$[
  {
    "name": "Fit",
    "scale": {
      "kind": "integer",
      "min": 1,
      "max": 5
    },
    "definition": {
      "1": "No fit: the program or investor does not fund work like Joe's.",
      "2": "Weak fit: adjacent field or stage, a stretch to apply.",
      "3": "Plausible fit: eligible, but not what they usually fund.",
      "4": "Good fit: funds work like Joe's at Joe's stage.",
      "5": "Direct fit: funds exactly this kind of work, stage and applicant."
    },
    "weight": 1,
    "judge_instructions": "Score Fit from the program or investor's stated focus, eligibility and portfolio: how well it matches Joe's work and stage."
  },
  {
    "name": "Timing",
    "scale": {
      "kind": "integer",
      "min": 1,
      "max": 5
    },
    "definition": {
      "1": "Wrong time: Joe could not use or qualify for this now.",
      "2": "Early or late: it fits a different phase of the work.",
      "3": "Workable: the timing neither helps nor hurts.",
      "4": "Good timing: it fits where the work is now.",
      "5": "Ideal timing: it fits the work's current phase exactly."
    },
    "weight": 1,
    "judge_instructions": "Score Timing from the program or investor's cycle and the work's current phase: whether now is the right moment to pursue it."
  },
  {
    "name": "Deadline",
    "scale": {
      "kind": "integer",
      "min": 1,
      "max": 5
    },
    "definition": {
      "1": "Passed or impossible: no realistic way to apply in time.",
      "2": "Very tight: applying in time would displace other work.",
      "3": "Tight but feasible: enough time with focused effort.",
      "4": "Comfortable: ample time to prepare a strong application.",
      "5": "Open: rolling intake or a deadline far enough away to prepare well."
    },
    "weight": 1,
    "judge_instructions": "Score Deadline from the stated deadline or intake schedule: how much room there is to prepare a strong application."
  },
  {
    "name": "Value",
    "scale": {
      "kind": "integer",
      "min": 1,
      "max": 5
    },
    "definition": {
      "1": "Not worth the effort: the award or terms cost more than they give.",
      "2": "Low value: small relative to the effort or with heavy strings.",
      "3": "Moderate value: worth pursuing if the effort is small.",
      "4": "High value: meaningful money, access or credibility.",
      "5": "Exceptional value: changes what the work can do."
    },
    "weight": 1,
    "judge_instructions": "Score Value from the amount, terms and non-financial benefits relative to the effort of applying."
  }
]$json$,
  $json${
  "allowed_scorers": [
    {
      "kind": "human",
      "identity": "joe"
    }
  ],
  "source_blind": false
}$json$,
  $json${
  "method": "weighted_sum",
  "tie_breaks": [
    "Fit",
    "Timing",
    "Deadline",
    "Value"
  ]
}$json$,
  'joe', '2026-11-16T00:00:00Z', NULL
);

INSERT INTO schema_migrations (version, name) VALUES (2, 'funding_corpus');
