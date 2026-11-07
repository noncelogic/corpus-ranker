# Refined definitions v3 — Corpus Ranker & Loop Closer
Date: 2026-11-07 · Definitions by: Joe Graham, in his words (00:29 EST)
Status: DRAFT v3 for Joe's sign-off. Supersedes v2 on system boundaries and on Loop Closer's ontology.
Retained from v2 (per-project, independently): frontier cross-check fixes on authority (sender defaults to Joe-approves-each for external sends), measurable kill criteria, typed supersession, Score retraction, publish qualified to internal / per-item approval. Those fixes now apply inside each system separately, not as a shared schema.

## The distinction (Joe, working position)
The two are **fundamentally different** systems. Internal-first stands for both (Joe, 00:19 EST). They do **not** share a persistence or retrieval mechanism. They may share only a thin cross-reference contract: stable IDs, a provenance format, and agent identity — enough for one system to point at an object in the other, nothing more.

---

## 1. Corpus Ranker
**In Joe's words: capturing, classifying and ranking.**

- **Job:** take in a corpus of research bits, keep the originals, classify them into canonical items, score them under versioned criteria/policies, and rank them into explainable Top-N views.
- **Confirmed recurring corpora (Joe, 2026-11-07 00:39 EST — "the use cases i have had and will continue to have over and over"):** research papers; investors & funding opportunities; jobs + salary data; experiment backlog / harness traces; social research gathered for reports. These are first-class corpora in the intended use, not speculative extensions.
- **Pipeline:** capture (raw, immutable, with provenance + hash) → classify (propose → commit; dedup; graph edges such as cites / derived-from) → score (append-only Score events under a rubric version, by human/program/LLM judge, optionally source-blind; scoring ≠ ranking ≠ sorting, Joe 2026-10-31) → rank (saved views: absolute, percentile, composite; every entry can `explain_score`).
- **Persistence:** corpus-shaped, four layers — blob originals / structured canonical records / versioned vector index / typed citation edges.
- **Retrieval:** vector similarity, rubric/score filters, citation-graph traversal, analytical Top-N queries, and full replay for re-scoring under a new rubric (old scores never destroyed).
- **Character:** append-heavy, batch-friendly. Stale output is fixed by re-deriving it from the raw corpus.
- **First dogfood:** the AI research corpus (2,876 papers scored since 2026-10-05 as of 2026-10-31; Relevance + Technical Merit; 70 at 5+5).

## 2. Loop Closer
**In Joe's words: tracks who, what, when — where any of these objects can be graph nodes and related causally or otherwise.**

### Ontology — Who / What / When, all first-class nodes
- **Who** — an actor node. Can be a **person or a thing**: a human, an agent, a system/service, a device/sensor — anything that can act, owe, be waited on, or be updated.
- **What** — a subject node. Can be an **action or a thing**: an action to be taken/done, a deliverable, an artifact, a fact/objective — anything acted on, gathered from, or updated.
- **When** — a trigger/temporal node. Can be **when an event is fired** (something happens in the world or in a system) **or a calendar event** (a time, a deadline, a scheduled moment). When is not just a clock ageing a record — an event firing is a When node in its own right, and it can be the cause of what happens next.
- **Edges:** any Who/What/When node can be related to any other, **causally or otherwise** — causes, enables, blocks, depends-on, responds-to, supersedes, evidences, owns, is-waiting-on, and other relations as the loop requires. Causality is a first-class edge type, not an annotation.

### Job
Maintain the Who/What/When graph as live, supersedable memory; represent an open loop as a subgraph (an accountable Who, a What, a When that would move or close it, and the causal chain between them); and create ad-hoc workflows that close loops — publishing research, GTM/outreach, financial or any objective tracking, accountability — by gathering/updating information from Whats and updating Whos on progress. A workflow is triggered by a When node: an event firing, a calendar moment arriving, or a causal condition in the graph becoming true.

### Persistence & retrieval (distinct from Corpus Ranker)
- **Persistence:** live operational graph + event ledger + communication threads. State transitions are consistency-critical: a loop transition lost or double-applied means someone is chased twice or never.
- **Retrieval:** exact/relational lookup, graph traversal over Who/What/When and their causal edges, and temporal/event queries — which loops are open, what When are they waiting on, has that event fired, what does this event causally set in motion. Vector similarity is at most an auxiliary (e.g. identity dedup), never the core retrieval path.
- **Character:** small, live, and current-state-critical — the opposite profile from a batch corpus. Supersession here takes effect immediately: it changes who/what is current, what is waited on, and what fires next.

### Guardrails carried from v2
- External sends are not autonomous by default: chaser/drafter/sender are separate actors; sender acts under a per-loop-type authority field, default Joe-approves-each, with chase caps and stop conditions.
- Loops are proposed, then accepted (by the accountable Who or Joe) with a dedup check — commitments do not appear from nowhere.
- "Ad-hoc" in v1 = template instantiation + composition from a generic gather→update primitive; novel workflow synthesis is out of scope for the internal phase.
- Health metrics, instrumented (not gates — see Kill criteria below): loops breaching their When/ageing expectations, Joe-correction rate, median open age alongside abandonment count. If the system needs Joe to maintain it, it redesigns toward less state.

---

## Kill criteria (Joe, 2026-11-07 01:03 EST) — settled, applies to both systems
Joe: "Kill-criteria, probably none, unless someone offers it as a service for really cheap. I intend to use it for all of the use cases you gave in your examples and much much more."
- **No usage-threshold kill tests.** These systems are not experiments on trial for adoption; Joe's intended use is all of the example corpora and loops, and much more beyond them. The blank thresholds from v2 are removed, not filled in.
- **The only exit is a replace trigger, with BOTH conditions (Joe, 01:04 EST):** a service offering the same two operations would have to be really cheap **and way better than what he has**. Cheap alone doesn't displace a working system. This is Joe's standing adopt-the-most-finished-thing doctrine, and the portability requirement is what makes the trigger usable: the store being his means a qualifying successor is an import, not a loss.
- **Weight (Joe, 01:04 EST):** "i kinda see this as being 'the software' that's going to run my life." The pair is Joe's intended personal operating layer — designed and prioritised at that weight, which is the substantive reason there are no kill criteria.
- Instruments from v2 (ranking→action ledger events; loop breach %, Joe-correction rate, median open age) stay as **health metrics** — they inform redesign, they never gate survival.

## Corpus scope extension (Joe, 2026-11-07 00:53 EST)
The corpus is not limited to research/evidence items. It includes the user's own material — all office documents the agent tracks, and all personal photos — still captured, classified, and ranked when the user looks for a particular subject area. Item types are therefore multimodal (documents, photos/media, text evidence) from the start, and classification/ranking must work over a lifetime personal archive, not just curated research intake.

## Portability requirement (Joe, 2026-11-07 00:42 EST) — applies to both systems
If a frontier harness ran either system, switching platforms must not lose the user's personal memory/life: the corpus, the loops, the tracking matter, and **how they are relevant to the user**.
- **System of record lives outside any harness**, in a user-owned store, in open/exportable form. The harness is an interchangeable reader/executor connected via API/MCP — never the owner of the data.
- **Relevance is explicit data, not model vibes:** why an item matters to this user is stored as rubrics, score events with reasons, causal/relational edges, and objectives — all exportable. Anything whose relevance lives only in a model's implicit synthesis of chat history is, by definition, unportable, and is a defect in this design.
- **Switching = re-pointing, not migrating:** a new harness generates its native instruction/context files from the store and compiles context per turn; the store does not move. Test: the zero-context (goldfish) test — a fresh harness with only store access must reconstruct what is top-ranked, what is open, and what matters.
- **Continuous, not an event:** export is the normal state (the store is already yours), not a vendor export ZIP requested at exit time.

## Storage convergence, refined (Joe, 2026-11-07 00:57 EST)
Joe: "maybe a graph db and a vector db could be used for both, because whatever the answer or action is it's probably cheaper for the output to be vectorized."
- **Shared component technologies, opposite weights — NOT the superseded one-substrate position.** Corpus Ranker: vector-primary, graph-secondary (typed citation/classification edges). Loop Closer: graph-primary (the Who/What/When causal graph IS the state), vector-auxiliary (identity matching, thread/message lookup, candidate next actions).
- **Loop Closer's boundary holds:** its transactional state machine/ledger stays exact and non-vector. Vectors index its content and serve its read path; they never carry its state — "similar" is not an acceptable answer to "is this loop open?"
- **Vectorized read path:** in both systems, retrieval hands the model pre-vectorized context instead of raw text, so a lookup costs fewer tokens whichever system serves it — the context-management goal's per-turn compilation, applied to both read paths. (Embeddings remain derived and rebuildable from the store, per the portability requirement.)

## What is NOT shared
- No shared database instance, schema freeze, retrieval stack, or ranking engine. (Shared: the two storage technologies, per the convergence note above.)
- Corpus Ranker's Score/Rubric machinery does not govern Loop Closer unless Loop Closer adopts it for a specific purpose by its own decision; Loop Closer's causal Who/What/When graph is not Corpus Ranker's citation graph.
- Cross-references are by ID and provenance pointer only (e.g. a Loop Closer loop about publishing a Corpus Ranker Top-N view points at that view).
