# SPEC — Corpus Ranker & Loop Closer
Date: 2026-11-07 · Status: DRAFT spec, for Joe's review. Not a build authorisation.
Governing document: `REFINED-DEFINITIONS-v3.md` (Joe's definitions, itself still DRAFT). Where this spec and v3 disagree, v3 wins. Companion: `TECH-STACK.md` (proposal, undecided).

## Standing constraints this spec is built under

1. **Internal-first.** Both systems are internal platforms for Joe, dogfooded on Joe's own corpora and loops. Externalisation is a separate, undecided, premise-class question — nothing in this spec designs for external users, tenants, pricing, or distribution.
2. **Two systems, not one substrate.** They share no database instance, no schema, no retrieval stack, no ranking engine. The only shared things are: (a) a cross-reference contract — stable IDs, a common provenance format, agent identity, typed supersession terms — so one system can point at an object in the other; (b) two storage *technologies* (graph + vector), used at opposite weights.
3. **Policies are first-class, versioned, portable data in both systems.** A policy is never a prompt, a model habit, or a code constant. Every score cites the policy version that produced it; every loop behaviour cites the policy version that governs it.
4. **Portability is a requirement, not a feature.** The system of record lives outside any harness, on Joe's estate, in open formats. Relevance is explicit stored data. Switching harness = re-pointing, verified by the goldfish test (§4).
5. **No kill criteria.** Health metrics exist (they inform redesign); they never gate survival. The only exit is Joe's replace trigger: a service that is really cheap **and** way better.
6. **Authority default (decided):** external sends default to `joe-approves-each` per loop type. Nothing in this spec grants autonomous external sending.
7. **Scoring ≠ ranking ≠ sorting** (Joe, 2026-10-31). A score is an append-only evaluative event under a versioned policy. A ranking is a derived view over scores. A rating field is neither.

Anything in this spec marked **OPEN QUESTION** is not decided by Joe. It is not defaulted here, and a builder must not silently default it either. All open questions are collected in §6.

---

# Part A — Corpus Ranker

## A1. Purpose

Corpus Ranker takes in a large, messy pile of material — research papers, funding opportunities, job posts, experiment ideas, social posts, office documents, personal photos — keeps the originals, classifies each piece into a canonical item, scores items under explicit versioned criteria, and produces small, explainable ranked views in answer to a subject-area question. It answers: *what's best in the pile, for this subject, for Joe — and why?* Nothing in it owes anyone anything; it has no counterparties and sends nothing.

## A2. Core data model

All IDs are opaque, stable, system-assigned (`cr_item_…` etc.), never reused, never recycled after tombstoning.

### A2.1 Corpus
A named collection with one intake shape and one classification taxonomy.
- `id`, `name` (papers, funding, jobs, experiments, social-research, office-docs, photos, …), `description`
- `taxonomy_id` → Taxonomy (versioned set of classification labels for this corpus)
- `created_at`, `status` (active | paused | archived)

Adding a corpus is data, not code. (**OPEN QUESTION Q7**: who approves a taxonomy for a new corpus.)

### A2.2 Original (raw blob record)
The immutable evidence layer. Every Item traces to at least one Original.
- `id`, `corpus_id`
- `content_hash` (SHA-256 of the bytes; content-addressed storage key)
- `media_type` (application/pdf, image/jpeg, text/html, text/plain, …)
- `byte_size`, `storage_uri` (object storage location)
- `source` — provenance: where it came from (URL, feed, inbox, upload, API), captured-by agent identity, `captured_at`
- `raw_metadata` (JSON — source-native fields, e.g. arXiv ID, EXIF for photos)
- `tombstoned_at`, `tombstone_reason` — null unless forgotten (see A2.9)

Originals are never edited and never deleted for tidiness. The only removal path is tombstoning (A2.9).

### A2.3 Item
The canonical unit a corpus is about — one paper, one funding program, one job, one photo.
- `id`, `corpus_id`
- `item_type` (paper | opportunity | job | experiment | post | document | photo | …)
- `title`, `summary` (system-generated, regenerable)
- `canonical_fields` (JSON, shape per item_type — e.g. paper: authors, venue, arxiv_id; photo: taken_at, location, people tags)
- `original_ids[]` → Original (one Item may rest on several Originals, e.g. a paper's PDF + HTML)
- `identity_keys` (JSON — dedup keys: arxiv_id, DOI, URL, perceptual hash for photos)
- `status` (active | merged | superseded | tombstoned)
- `created_at`, `updated_at`

### A2.4 Classification
A committed label assignment on an Item. Classifications are proposed by an agent/program, then committed (by a commit step — auto-commit is a per-corpus policy field, not a global assumption).
- `id`, `item_id`, `taxonomy_version`
- `labels[]` (paths in the taxonomy, e.g. `research/context-management`)
- `proposed_by` (agent/human identity), `committed_by`, `committed_at`
- `confidence`, `rationale` (short text)
- Reclassification creates a new Classification record; history is kept.

### A2.5 Edges (graph-secondary)
Typed links between Items (and to external IDs, including Loop Closer object IDs by cross-reference).
- `from_id`, `to_id`, `edge_type` (cites | derived_from | same_as | supersedes | evidences | classified_under | part_of)
- `created_by`, `created_at`, `evidence` (pointer to Original/Score that justifies the edge)
- `same_as` is a **reversible merge event**, not a fact overwrite: it records the merge decision and its provenance; split must be possible.

### A2.6 Policy (the rubric) — first-class, versioned
The ranking policy object. This is the portable unit of relevance.
- `id`, `name` (e.g. `paper-rubric`), `corpus_id`
- `version` (integer, monotonic; a Policy is edited by creating a new version — versions are immutable once any Score cites them)
- `dimensions[]`: each = { `name` (Relevance), `scale` (e.g. 1–5 integer), `definition` (what each level means, in words), `weight` (for composites), `judge_instructions` }
- `judge_config`: who may score (human | named program | named LLM judge config), `source_blind` (bool — whether the judge sees source/provenance)
- `composite_rule`: how dimension scores combine into ranked order (weights, tie-breaks) — data, not code
- `created_by`, `created_at`, `supersedes_version`

### A2.7 Score event — append-only
One evaluation of one Item under one Policy version. Never a column on Item; never overwritten.
- `id`, `item_id`, `policy_id`, `policy_version`
- `dimension_scores[]`: { `dimension`, `value`, `reason` (required — the why), `evidence[]` (pointers to Originals/spans) }
- `scorer` (identity: joe | agent id | program id + model/config where applicable)
- `scored_at`, `source_blind` (as actually run)
- `retracted_at`, `retraction_reason` — a Score is invalidated only by a **retraction event** recorded on it; the score itself stays in history, marked retracted, and is excluded from rankings from that moment. Rankings computed before retraction are marked stale (A2.8).

### A2.8 Ranked View
A saved, reproducible derivation — not a sort.
- `id`, `name`, `corpus_id`, `policy_id`, `policy_version`
- `query`: the subject-area question / filters / vector query that scoped the view
- `entries[]`: { `item_id`, `rank`, `composite`, `score_event_ids[]` (the exact scores used) }
- `computed_at`, `stale` (bool) + `stale_reason` — set when an entry's Item is superseded/merged, an entry's Score is retracted, or the Policy version is superseded. A stale view is never silently presented as current; re-ranking produces a new view version.
- `action_events[]`: the ranking→action ledger — every action taken from this view is logged against it: { `item_id`, `action_type` (picked | promoted | pursued | rejected), `actor`, `at` }. This is a health instrument, not a gate (§Standing 5).

### A2.9 Tombstone (verified forgetting)
- Forgetting removes content but preserves the hash and the fact of existence: Original bytes are destroyed, the record keeps `content_hash`, provenance, and `tombstone_reason`; dependent Items are marked tombstoned; dependent views go stale.
- This is the single exception to "never delete raw," and it exists for exactly one purpose: verified forgetting, invoked deliberately. (**OPEN QUESTION Q9**: which categories Joe can tombstone, and who may invoke it.)

### A2.10 Embedding record (derived, disposable)
- `item_id` (or chunk id within an Item), `embedding_model_id`, `model_version`, `dims`, `vector`, `built_at`, `source_hash` (hash of the text/image embedded)
- Embeddings are a rebuildable index, never the record. Any embedding can be deleted and regenerated from Originals + canonical fields. Changing embedding model = new records alongside old, then cutover.

## A3. API surface

Transport-neutral operation names; the concrete bindings are in TECH-STACK.md (REST + MCP over the same operations). Every write carries an agent identity; per-agent, per-operation access scopes apply (an intake agent can write Originals and cannot commit Classifications or Scores — scopes are data, enforced by the service).

| Operation | Inputs | Outputs / effect |
|---|---|---|
| `capture` | corpus_id, bytes or source URL, source provenance, captured_by | Original record (id + hash). Dedup check on hash: re-capture of identical bytes returns the existing Original. Raw only — never scores or classifies inline. |
| `classify_propose` | item_id (or original_id), labels, rationale, confidence | Pending Classification |
| `classify_commit` | classification_id, committed_by | Committed Classification; may set Item canonical fields; may create same_as merge (reversible) |
| `score` | item_id, policy_id, policy_version, dimension scores + reasons + evidence, scorer identity, source_blind flag | Score event id. Rejects a policy version that is not the cited one. |
| `retract_score` | score_event_id, reason, actor | Score marked retracted; dependent views marked stale |
| `rank` | corpus_id, policy_id (+version), query (subject text and/or filters), N | New Ranked View (entries with composite + score citations) |
| `get_top_n` | view_id **or** (corpus_id, policy name, query, N) | Ordered entries: item summary, composite, per-dimension values — small enough to hand a model as pre-digested context |
| `explain_score` | item_id, policy_id | Every contributing Score event: dimension, value, reason, evidence, scorer, policy version; plus retraction/supersession state of the item and its evidence |
| `replay` | policy_id, from_version, to_version, corpus_id | Re-scores (or re-derives composites) over the stored corpus under the new policy version without touching old Score events; produces new views; reports a diff summary (what moved, by how much) |
| `search` | corpus_id, subject query, filters (labels, score ranges, date) | Vector + filter retrieval over Items, ranked by similarity, **unscored items included and marked as such** — retrieval is not ranking |
| `supersede_item` | item_id, new_item_id or reason, type (fact replacement) | Old Item marked superseded; edges written; dependent views stale |
| `tombstone` | original_id or item_id, reason, actor | Verified forgetting per A2.9 |
| `export` | corpus_id (or all), format | The full portable bundle (§A5) |

## A4. Policy objects in Ranker

- A rubric **is** a Policy (A2.6). There is no other way to score: `score` refuses a call that does not cite a policy id + version.
- Policy changes never edit history: new version → `replay` → new views. Joe can always answer "under the rules as of March, what was top?" by ranking at the old version.
- Policies export and import as plain data (§A5). Carrying the rubrics is carrying the relevance — that is the point of the portability requirement.

## A5. Portability: export format and the goldfish test

**Export bundle** (a directory or single archive, producible on demand and on schedule):
- `manifest.json` — bundle version, export time, counts, hashes
- `originals/` — the raw bytes, named by content hash
- `items.jsonl`, `classifications.jsonl`, `edges.jsonl`, `scores.jsonl`, `policies.jsonl`, `views.jsonl` — one JSON object per line, IDs preserved
- Embeddings are **not** in the bundle by default (derived; rebuild on import). An optional `embeddings/` section may include them as a cache, clearly marked disposable.

**Goldfish test (Ranker)** — run after any harness change, and on a schedule as a drill:
1. Start a fresh agent/harness instance with **no** prior context — no memory files, no chat history. Give it only: API/MCP access to Ranker and the export bundle location.
2. Ask it three things, cold: (a) the current Top 10 for a standing subject area under the current policy version; (b) *why* item #1 is #1 (it must produce the explain_score chain: dimensions, reasons, policy version); (c) what changed in the ranking when the policy last changed version.
3. Pass condition: all three answered from the store alone, matching the live views. Any answer it cannot produce is a defect **in the store** (missing explicit data), filed and fixed — not worked around with prose memory.

## A6. Non-goals (Ranker)

- Not a CRM, not a task manager, not a notes app. No counterparties, no outreach, no state about who owes what — that is Loop Closer.
- No external users, no publishing/distribution of views to anyone but Joe and his agents in this phase. (Publication is part of the undecided externalisation question.)
- No scoring without a cited policy version. No ranking that cannot `explain_score`.
- No deleting raw material for tidiness — tombstone only, for verified forgetting.
- Not a general search engine over the public web. Capture is intake of material Joe's agents gather; gathering itself is the agents' job.

## A7. Phased build order (Ranker)

- **Phase 0 — Import the existing corpus.** Load the 2,876-paper AI research corpus from its weekly JSONL files: papers become Items, PDFs/links become Originals, the existing Relevance + Technical Merit rubric is encoded as `paper-rubric` v1, existing scores become Score events under it (scorer and date preserved from the files). Exit check: the all-time leaderboard (incl. the 70 papers at 5+5) is reproduced from Ranker and matches the JSONL-derived one.
- **Phase 1 — The daily path runs on Ranker.** capture → classify → score → rank → get_top_n serves the daily paper flow; the daily Top-N is produced from a Ranked View, not from ad-hoc JSONL handling. Replay exercised once with a deliberate rubric v2 experiment on a copy, to prove re-scoring without history loss.
- **Phase 1.5 — Citation & repo enrichment (Joe, 2026-11-07 10:26 EST: "not just papers but papers the papers cite and github repo urls the papers refer to").** From each paper's full text: (a) extract its references → `cites` edges; a cited paper not yet in the corpus becomes a stub Item (dedup by arXiv ID / DOI) and a capture candidate — snowball intake beyond the daily feed; (b) extract GitHub repo URLs → repo Items linked by an `artifact` edge, with basic repo facts captured (exists, last activity, licence). **How these feed ranking — as evidence under policy, never as automatic boosts** (scoring stays policy-governed; Joe's settled rule: buzz is a discovery signal, never a quality verdict): (1) *in-corpus weighted in-degree* — being cited by high-scored corpus papers is relevance evidence for the judge; it accrues over time, so it mainly re-ranks older items on replay (the daily corpus is new preprints — citation signal is ~zero at intake and lagging by nature, as in the current pipeline); (2) *repo presence and runnability* is Technical Merit / experiment-feasibility evidence (a live repo supports merit and makes the paper actionable); (3) *repo stars/forks are buzz-class* — discovery only, excluded from quality scoring. Cross-system: the repo Item is also the natural What for a Loop Closer research-papers loop (experiment waits on repo-ready).
- **Phase 2 — Second corpus: investors & funding.** New corpus, new taxonomy, new policy (Fit / Timing / Deadline / Value). Proves the model is not paper-shaped. Jobs corpus follows the same pattern (**OPEN QUESTION Q11** on how it relates to Hermes's current job tracking).
- **Phase 3 — Personal material.** Office documents corpus, then photos corpus (multimodal: perceptual-hash dedup, image embeddings, EXIF as raw metadata). (**OPEN QUESTION Q5/Q6**: source libraries and access for each.)

---

# Part B — Loop Closer

## B1. Purpose

Loop Closer maintains a live graph of who owes what to whom, what it depends on, and what event or moment will move or close it — and drives those loops closed with ad-hoc workflows built from a small set of primitives. Its nodes are Who (a person **or a thing** that can act, owe, be waited on, or be updated), What (an action **or a thing** — a deliverable, an artifact, a fact, an objective), and When (an event firing **or** a calendar moment — a first-class node that can cause the next step). It answers: *what is still open, who owes what, since when, and what happens next?* Its state is live and consistency-critical: a transition lost or double-applied means someone is chased twice, or never.

## B2. Core data model

### B2.1 Node
One table/type-space, three kinds. Every node has: `id` (stable, `lc_…`), `kind` (who | what | when), `created_at`, `status` (active | superseded | merged | tombstoned), `attributes` (JSON, kind-specific).

- **Who** — `who_type` (person | agent | system | device | organisation), `name`, `contact_points[]` (channel + address, each with `valid_during` interval — a contact that *was* right stays queryable as-was), `external_ids` (IDs in other systems).
- **What** — `what_type` (action | deliverable | artifact | fact | objective). Objectives carry `target` (structured: metric, value, unit) and `current_value` — **versioned revisions**: a target change is a new revision with a diff, never a quiet overwrite. A What may cross-reference a Corpus Ranker object (by Ranker ID + provenance pointer only).
- **When** — `when_type`:
  - `event`: `event_type` (a named occurrence — `reply_received`, `deploy_green`, `payout_posted`, …), `source_binding` (which system/sensor reports it, and how — webhook, poll, manual fire), `fired_at` (null until fired), `fire_count`
  - `calendar`: `schedule` (one-off datetime or recurrence rule), `timezone`, `next_fire_at`
  - A When fires by `fire_event` (B3); firing is itself a ledger event. A When may fire more than once (recurring calendar, repeated event) — each firing is distinct.

### B2.2 Edge
Any node → any node, typed, with causality as a first-class type.
- `from_id`, `to_id`, `edge_type`: causal (causes | enables | blocks) and non-causal (depends_on | responds_to | supersedes | evidences | owns | is_waiting_on | updates | gathers_from)
- `created_by`, `created_at`, `evidence` (ledger/Communication pointer justifying the edge)
- Edges are added and (by a new edge or a retraction record) superseded; the as-was graph stays queryable by ledger time.

### B2.3 Loop
A Loop is a named subgraph plus a state record. The subgraph is the truth; the record is its handle.
- `id`, `name`, `loop_type` (publishing | outreach | deploy-watch | objective-tracking | grant | errand | … — new types are data)
- `state`: proposed | open | waiting | chased | closed | closed_with_reason (abandoned / superseded / no-longer-applies) — transitions only via `transition` (B3), each writing a ledger event
- `accountable_who_id` → Who (who owes the next move)
- `member_node_ids[]` — the subgraph: the Whos, Whats, Whens and the edges between them
- `closing_when_id` → When whose firing closes (or is a condition of closing) the loop
- `authority` (see B2.6) — the send authority in force for this loop, inherited from its loop type's policy, overridable per loop only toward *less* autonomy without Joe
- `opened_at`, `closed_at`, `close_reason`
- `policy_refs`: ageing policy id+version, escalation policy id+version governing this loop

A loop exists only after intake: `propose_loop` → dedup check → `accept_loop` (B3). Commitments do not appear from nowhere.
**Ranked results propose loops (Joe, 2026-11-07 10:31 EST):** a Corpus Ranker Top-N view is a first-class loop source — job-search and funding-search results each propose an application loop for the entries Joe pursues: Who = [Joe], [the employer/program — external counterpart]; What = [prepare the packet — action; the application packet — thing; submit — action]; When = [deadline — calendar] fires preparation, [submission confirmed — event] closes intake and opens the decision-wait loop. This is the Ranker→Closer handoff as a designed pattern: ranking ends at the list; pursuing an item opens its loop through the same propose→accept intake, nothing auto-obliges.
**Loop types name their comms executor (Joe, 2026-11-07 10:31 EST):** each loop type carries an executor routing — which agent runs its communications. Named instance: **BCBA scheduling & comms** — Who = [Joe/Karina], [Brianna Richardson, BCBA at Links ABA], [Suzanne, covering BCBA]; What = [session scheduling], [case comms]; the comms happen on Gmail, and the loop type routes through **Hermes** as executor (Hermes's established lane: drafting email on Joe's personal account, tracking personal projects, reporting — sends still under the loop type's authority policy, default Joe-approves-each). Real-world warrant: this exact loop has already dropped stitches under manual tracking (Nov 5–6: a prepared thank-you to Brianna never sent; a Hermes-drafted email to Links never saved or sent) — loops that existed nowhere as tracked state. This type also fits the Phase-2 generalisation-gate shape (external counterpart; waiting states Joe didn't cause); whether it IS the gate type is Joe's call, unmade.
**Directory-listing loops — things we chase (Joe, 2026-11-07 10:33 EST: "we might need to chase stuff like our anthropic listings"):** Who = [Joe], [the directory operator — e.g. Anthropic's review team, an external counterpart], [an agent as chaser]. What = [the listing — thing], [its live public metadata fields — thing], [a status nudge — action]. When = [review ageing past a policy threshold with no reviewer movement — calendar] fires a status check (read-only checks are the chaser's autonomous lane); [status change — event: scanning → in review → live, or change-requested] fires the next workflow (celebrate/close, or a fix loop); [every version filed — event] fires the metadata readback (Joe's standing ROVE-713 rule, carried here as loop policy: live fields read back and corrected until they match). Live instances at design time: the Rove connector listing, in Anthropic review since 2026-10-17 with no reviewer notes as of the 2026-11-06 check — three weeks of silence that nothing was tracking as an ageing loop; and the Rove plugin listing filed 2026-11-06 (status "Scanning" at filing).

### B2.4 Event ledger — append-only, the system's memory of itself
Every state change in Loop Closer is a ledger event, written in the same transaction as the change it records. The ledger is never edited; corrections are new events.
- `id`, `at`, `actor` (who/agent identity)
- `event_type`: loop_proposed | loop_accepted | loop_rejected | transition | when_fired | communication_sent | communication_received | gather_performed | supersession | merge | split | manual_correction (Joe-initiated status fix — a named type, because it is a health metric) | tombstone
- `subject_ids[]` (loop/node/edge IDs touched), `payload` (JSON — before/after for transitions, message pointer for communications)
- `idempotency_key` (for event-driven transitions — the same external event delivered twice applies once)

### B2.5 Communication
The evidence object for communications loops — a transition into or out of `waiting`/`chased` must cite one (or a gather event).
- `id`, `thread_id`, `channel` (email | message | other), `direction` (outbound | inbound)
- `participant_who_ids[]`, `at`, `body_pointer` (artifact/Original reference), `body_hash`
- `loop_id` it belongs to, `sent_under_authority` (the authority value in force when sent; null for inbound)

### B2.6 Authority — per loop type, first-class field
- `authority`: autonomous | joe-approves-each | joe-approves-template
- Set on the loop-type Policy (B4); **default is `joe-approves-each`** (decided). A loop inherits its type's value.
- Actor separation is enforced around it: the **chaser** detects and files (sends nothing), the **drafter** composes (sends nothing), the **sender** acts — and the sender may only act within the loop's `authority` value. Under `joe-approves-each`, a send with no recorded Joe approval for that specific communication is rejected by the service, not merely discouraged.

### B2.7 Workflow template + run
"Ad-hoc" in this phase = template instantiation + step-level composition from the generic primitive; novel workflow synthesis is out of scope (decided, v3/cross-check).
- **Template**: `id`, `name`, `version`, `steps[]` — each step = { `primitive` (gather | update | draft | send | wait | transition), `actor_role` (chaser | drafter | sender | system), `params`, `on_failure` }. Templates are versioned data.
- **Generic primitive**: gather-from-a-What → update-a-Who. Most workflows are this primitive dressed per loop type.
- **Run**: `id`, `template_id+version`, `loop_id`, `triggered_by` (ledger event id — usually a When firing), `state` (running | waiting_approval | done | failed), `step_log[]` (per-step outcome + ledger event pointers).

### B2.8 Typed supersession (Loop Closer semantics — immediate effect)
Supersession here is not one operation; the type is required:
- `fact_replacement` — new node/value replaces an old one as current; takes effect immediately (what is waited on, who is chased, changes now).
- `valid_during` — not a replacement at all: state true for an interval (contact points, roles). Both intervals remain queryable.
- `same_as_merge` / `split` — identity merge of two Who (or What) nodes, recorded as a reversible event with the decision's provenance. A wrong merge makes the system chase the wrong person, so merge/split are deliberate, logged operations — never a silent side effect of dedup.
- `objective_revision` — a What-of-type-objective gets a new target revision; the diff is surfaced to the accountable Who, not hidden.
- `loop_supersession` — a loop is replaced by another loop; the event names *what* was superseded (the objective, the loop, or the counterpart Who) — the three are not interchangeable.

### B2.9 Tombstone
Same rule as Ranker: verified forgetting destroys content, keeps hash + fact of existence + reason. Applies in particular to external parties' contact data held in Who nodes. (**OPEN QUESTION Q9**, shared with Ranker.)

## B3. API surface

Same transport rule as Ranker (REST + MCP over one operation set; agent identity and per-operation scopes on every call).

| Operation | Inputs | Outputs / effect |
|---|---|---|
| `propose_loop` | proposed subgraph (nodes/edges or references to existing nodes), loop_type, accountable Who, proposing actor, rationale | Dedup check against open loops on the same Who + What/objective; creates a Loop in `proposed` state + ledger event. Sends nothing, obliges nobody yet. |
| `accept_loop` | loop_id, acceptor (accountable Who or Joe) | Loop → `open`; its Whens become armed |
| `reject_loop` | loop_id, reason | Loop closed as rejected at intake; ledger event kept |
| `transition` | loop_id, to_state, actor, evidence (Communication/gather/ledger pointer), idempotency_key | Validated state change + ledger event, atomically. Invalid transitions rejected. Double-delivered events apply once. |
| `fire_event` | when_id **or** (event_type + source + payload), idempotency_key | Records the firing in the ledger; returns the set of loops/workflows the firing sets in motion; triggers workflow runs per templates |
| `open_loops` | filters (accountable Who, loop_type, state, breaching-only) | All non-closed loops with state, age, governing When, breach status vs ageing policy |
| `what_fires_next` | loop_id **or** when_id | For a loop: the When(s) it is waiting on and what each firing will cause (next transition / workflow). For a When: every loop that fires when it fires. This is a graph traversal over causal edges, answered exactly — never by similarity. |
| `supersede` | subject id, type (one of B2.8), replacement/diff payload, actor, reason | Typed supersession event + immediate effect on current state |
| `merge_nodes` / `split_nodes` | node ids, decision provenance, actor | Reversible same-as merge / split, ledger-recorded |
| `record_communication` | thread/channel/participants/body pointer, direction, loop_id | Communication record; may be cited as transition evidence |
| `request_send` | loop_id, draft Communication id, actor | Under `joe-approves-each`: creates a pending approval, sends nothing. Under a template/autonomous authority (only where Joe has set it): enqueues the send. The sender executes approved sends only. |
| `approve_send` | communication id, approver (Joe) | Releases exactly that communication to the sender |
| `health` | window | Breach % at snapshot, Joe-correction count, median open age **with abandonment count beside it** — metrics for redesign, never a kill gate |
| `export` | scope | The full portable bundle (§B5) |

## B4. Policy objects in Loop Closer

All loop behaviour is policy data, versioned, cited by ID+version on every loop:
- **Ageing policy** — per loop type: expected dwell per state, breach thresholds, what "stale" means for this type (current-for-a-publishing-loop ≠ current-for-a-funding-loop).
- **Escalation policy** — per loop type: when a breach escalates, to whom, how often; chase bounds are required fields: `max_attempts`, `min_interval`, `stop_conditions` (e.g. any reply stops chasing; a close-with-reason stops everything).
- **Authority policy** — the per-loop-type `authority` value (B2.6). Changing a type from `joe-approves-each` toward autonomy is a policy version change made by Joe, on the record.
- **Closure policy** — per loop type: what counts as closed vs closed-with-reason; which When firings may close automatically and which need a confirming transition.
- Loop-attention ordering (when more loops are breached than Joe can look at, what order are they shown in?) is **OPEN QUESTION Q3** — either a Score under a named urgency policy (which would mean Loop Closer adopting Ranker-style scoring for this one purpose, by its own decision) or explicitly operator-set and unranked in v1. This spec does not pick.

## B5. Portability: export format and the goldfish test

**Export bundle:**
- `manifest.json` — as Ranker
- `nodes.jsonl`, `edges.jsonl`, `loops.jsonl`, `ledger.jsonl`, `communications.jsonl` (body pointers + hashes; bodies exported where Joe's store holds them), `policies.jsonl`, `templates.jsonl`
- The ledger is exported in full and in order — a successor system must be able to replay it and arrive at the same current state. Current state is a *derivation* of the ledger plus node records, so export of those two is export of the system.
- Embeddings (auxiliary index only — identity matching, thread lookup) are excluded as disposable, exactly as in Ranker.

**Goldfish test (Loop Closer):**
1. Fresh harness, zero prior context, API/MCP access only.
2. Cold questions: (a) What is open right now, and who is accountable for each? (b) Pick the oldest open loop: what is it waiting on, and what happens when that fires? (c) Which loops are breaching their ageing policy? (d) What was the last thing sent in loop X, and under what authority?
3. Pass condition: all four answered exactly from the store, matching live state. A miss is a store defect (state that lived in an agent's head or a chat), filed and fixed.

## B6. Non-goals (Loop Closer)

- Not a task manager / to-do list. No free-floating tasks: everything in it is a loop with an accountable Who, a What, and a When.
- Not a system Joe has to maintain for it to stay true. If keeping it current needs Joe's manual upkeep, that is a design failure to redesign around less state — not a usage expectation.
- No autonomous external sending beyond a loop type's recorded authority; default `joe-approves-each`.
- No vector-derived state. Similarity may *suggest* (identity-match candidates, candidate next actions); it never decides that a loop is open, closed, or owed.
- No novel workflow synthesis in this phase — templates + composition only.
- No ranking of Joe's corpus — that is Ranker. Loop Closer points at Ranker objects by ID when a loop concerns one; it does not score them (except **OPEN QUESTION Q3/Q4**).

## B7. Phased build order (Loop Closer)

- **Phase 0 — Core without workflows.** Node/Edge/Loop/Ledger storage; propose → accept intake with dedup; manual `transition` and `fire_event`; `open_loops` and `what_fires_next` queries; calendar When support with the sensor ticking (see TECH-STACK). No sends of any kind.
- **The timer loop + sensors are first-class machinery, not plumbing (Joe, 2026-11-07 10:36 EST: "we are going to need a timer loop and sensors that trigger stuff" — agreeing there is no better solution on the table).** Two parts: (1) **the timer loop** — a periodic tick that asks which armed Whens are due and which loops have breached their ageing policy, and fires them (TECH-STACK §6: Postgres rows + per-minute tick + transactional outbox); (2) **sensors** — one per external source, each turning an outside change into a `fire_event`: calendar (time itself), portal/browser checks (the Anthropic-listings sensor is the canonical first instance — no API exists, so the sensor is a scheduled read), Gmail thread watchers (BCBA comms), CI/deploy webhooks (red-main loop), payment events (objective loops). Design constraint carried from Joe's own 2026-10-20 estate timer audit: today every detection is polling and silence reads as health — so every sensor carries a heartbeat, and a sensor that has not reported on schedule is itself an event the graph records (a dead sensor must look different from a quiet world).
- **Phase 1 — One real loop type, end to end.** (**Q2 DECIDED — Joe, 2026-11-07 10:23 EST: research papers.** The first loop type is the research-papers loop: the loops a top-ranked paper creates — publish the packet, run the experiment it proposes, update Joe when results land — pointing by ID at Corpus Ranker items, so both systems dogfood on the same domain first. The Phase-2 generalisation-gate second type is NOT yet named by Joe.) **Loop shape, per Joe's expansion (10:26–10:27 EST): the loop's graph is not just the paper — it includes the papers the paper cites and the GitHub repos the paper refers to, as What nodes with dependency edges.** Concretely (the worked example): Who = [Joe — approver], [agent — owes the work], [the paper's authors — counterparties], [GitHub — thing hosting repo + packet]. What = [the paper], [its repo — to run/replicate], [the cited papers — dependencies/context the experiment builds on], [the experiment — action], [the packet — produced thing], [notify the authors — action]. When = [repo runs — event] unblocks the experiment; [results land — event] fires evaluation; [Joe approves the packet — event] causes publish + author notify; [14 days, no author reply — calendar] causes a follow-up draft. Edges: experiment `blocked_by` repo-not-runnable; packet `depends_on` results; notify `caused_by` Joe approval; cited papers `evidences/context_for` the experiment (and a cited paper's own repo joins the graph when the method extends it). This matches Joe's real experiment close-out process (EXP-06 template: replicate → sanitised packet published → author emailed on Joe's per-item approval). The frontier cross-check's guidance, adopted here as the shape of the phase: pick the first type *for mechanics* (safe — no external party can be auto-chased, because authority default forbids it), with chaser + drafter live and the sender gated behind Joe's per-item approval. Communications recorded as evidence for every waiting/chased transition.
- **Phase 2 — Generalisation gate.** A **second** loop type, with an **external counterpart** and a **waiting state not caused by Joe** (funding/objective follow-up is the natural candidate), must run on the same data model with **no schema change**. Until that passes, Loop Closer is a pilot, not a validated platform — regardless of how well type #1 works.
- **Phase 3 — Templates and composition.** Workflow templates for the proven types, the gather→update primitive as the composition unit, escalation policies exercised against real breaches. Sender autonomy for any loop type only by Joe changing that type's authority policy, per type, on the record.

---

# §4 (shared). The cross-reference contract

The only coupling between the two systems:
- **IDs**: each system owns its ID space; a cross-reference is `{system, id}` plus a provenance pointer. Neither system writes into the other's store. Either reads the other only through its public API.
- **Provenance format**: one shared shape — { source, captured/recorded by (agent identity), at, hash where content exists }.
- **Agent identity**: one identity registry concept (an agent is the same named principal in both systems), with per-system, per-operation scopes granted separately.
- **Supersession vocabulary**: the typed terms in B2.8 / A2.5 are shared *words* with per-system semantics (Ranker: marks views stale, re-derive offline. Loop Closer: immediate effect on live state). Shared vocabulary, deliberately different mechanics — per Joe's correction of 2026-11-07 00:24 EST.

# §5 (shared). Health metrics (not gates)

- Ranker: ranking→action ledger coverage (how many published views have ≥1 logged action; how many ranking-derived actions per quarter).
- Loop Closer: ageing-policy breach % at weekly snapshot; Joe-initiated correction count per week; median open age **reported with abandonment count beside it** (so "age falling" can never be gamed by abandoning).
- These numbers inform redesign. Neither system is killed, demoted, or required to justify existing by them. The sole exit for both is Joe's replace trigger (really cheap **and** way better).

---

# §6. OPEN QUESTIONS for Joe

Nothing below is decided. Nothing below is defaulted in this spec or may be defaulted by a builder.

**Premise-class (Joe must decide explicitly; silence decides nothing):**
- **Q1 — Externalisation.** Whether either system is ever offered to anyone else, in any form. Undecided. This spec designs for Joe only.
- **Q5 — Photos source and access.** Which photo library (or libraries) the photos corpus ingests from, and what access is granted to do it.
- **Q6 — Office-documents source and access.** Which document stores the office-docs corpus ingests from, and what access is granted.
- **Q10 — System users beyond Joe.** Loop Whos include other people (e.g. family members in errand loops) as *tracked nodes* — that is decided by the ontology. Whether anyone besides Joe is ever a *user* of either system (own login, own approvals) is not decided.

**Design decisions owed:**
- **Q2 — First Loop Closer loop type. DECIDED (Joe, 2026-11-07 10:23 EST): research papers** — the loops a top-ranked paper creates (publish packet, run experiment, report results), cross-referencing Corpus Ranker items by ID. Still open within Q2: naming the Phase-2 generalisation-gate second type (must have an external counterpart and a non-Joe-caused waiting state; funding/objective follow-up is the standing candidate, unconfirmed).
- **Q3 — Loop attention ordering.** When breached loops exceed what Joe can review: ranked by a Score under a named urgency policy, or operator-set/unranked in v1?
- **Q4 — Objective progress in Loop Closer.** Are objective progress values computed as Scores under a policy (Loop Closer adopting Ranker's scoring machinery for this purpose, by its own decision), or recorded as plain versioned values without scoring?
- **Q7 — Taxonomy governance.** Who creates/approves the classification taxonomy for a new Ranker corpus, and who may commit taxonomy changes?
- **Q8 — Who identity-merge authority.** Who may approve a `same_as` merge or split of Who nodes (the high-stakes identity operation), and does it need Joe specifically?
- **Q9 — Forgetting.** Which categories of material may be tombstoned, and who may invoke verified forgetting (in both systems).
- **Q11 — Jobs corpus vs Hermes.** Hermes currently tracks jobs, by Joe's assessment badly. Does the Ranker jobs corpus replace that tracking, feed it, or run beside it?
- **Q12 — Coordination with neighbouring systems.** Do these schemas coordinate with Sortyard's data model (Joe expects policies to be first-class there too) and with the context-management database work (a likely third consumer of relevance data, currently research-stage)? Coordination, shared policy format, or deliberate independence — undecided.
- **Q13 — Names.** "Corpus Ranker" and "Loop Closer" are working titles from Joe's descriptions, not decided product names.
- **Q14 — Stack.** The contents of TECH-STACK.md are a proposal. Joe has not decided a stack.
