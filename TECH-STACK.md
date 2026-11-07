# TECH STACK — Corpus Ranker & Loop Closer
Date: 2026-11-07 · Status: **DECIDED — Joe Graham, 2026-11-07 10:17 EST: "go with original recommendations."** The recommendations below are adopted as the stack, including: Postgres system of record (separate DB per system), pgvector (Qdrant escape hatch), Postgres edge tables for graph with Neo4j as optional rebuildable projection only, MinIO originals, REST API + thin MCP adapter, TypeScript services + Python batch worker, API text embedder for v1 text corpora with self-hosted CLIP-family for images, and Ray NOT in v1 (named escape hatch for bulk backfill / self-hosted model serving). Per-corpus embedder switching remains a config choice the design explicitly preserves, not a reopened decision.
Companion: `SPEC.md`. Governing definitions: `REFINED-DEFINITIONS-v3.md`.

## How to read this document

Every major choice has: a **recommendation**, a one-line **why** tied to Joe's constraints, and the **main alternative** with why not. The constraints doing the work:

1. **Portability is the point.** The system of record must live on Joe's estate, in formats he can dump and walk away with. No vendor cloud silo as the store — a stack choice that traps the data fails the core requirement no matter how good it is.
2. **Estate-owned infra.** Joe already runs AKS, Postgres (CloudNativePG, in production for Cortexplane), Neo4j (in production for the X knowledge graph), OpenBao for secrets, Argo for deploys. Prefer what is already operated over what is new.
3. **Adopt the most finished, boring thing.** These systems run one person's life. Novel infrastructure is a liability, not an asset. Bespoke is justified only where nothing finished exists — the policy/scoring/loop semantics themselves.
4. **Two systems, separate stores.** Ranker and Loop Closer get separate databases and separate services (per v3: no shared database instance). They may run on the same *engines* — same Postgres cluster family, same object store — as separate databases/buckets, the way two apps share a Postgres server without sharing a schema.
5. **Scale honesty.** Lifetime personal archive + one person's loops = thousands to low millions of items, hundreds to thousands of loops. This is small. Every choice below is sized for that, with named escape hatches if it stops being true.

---

## 1. Shape of the whole thing

**Recommendation:** Two small services — `ranker` and `loopcloser` — one codebase repo each (or one repo, two deployables), each exposing (a) a REST/JSON API defined by an OpenAPI document, and (b) a thin MCP (Model Context Protocol) server that maps MCP tools 1:1 onto the same operations. Plus two supporting workers: an embeddings/classification batch worker (Ranker) and a sensor/scheduler worker (Loop Closer, §6).

**Why:** the API is the contract every harness — Juno today, a successor later — connects through; MCP is the dialect agents already speak, but making MCP the *only* surface would couple the store to one protocol. REST underneath, MCP as an adapter, means the goldfish test can be run by anything.

**Main alternative:** MCP-only services. Why not: harder to test, script, and export against; REST is the more durable, tool-agnostic contract. MCP-only optimises for today's harnesses — exactly the lock-in shape this project exists to avoid.

**Operator UI:** none in v1. Joe supervises through his harness and through ranked/open-loop views the APIs already return. A read-only web view is a later, separate decision. (Sortyard exists as Joe's UI-for-everything project; duplicating UI effort here is waste — and any coordination with Sortyard is SPEC OPEN QUESTION Q12, undecided.)

## 2. System of record (both systems): PostgreSQL

**Recommendation:** PostgreSQL (CloudNativePG clusters on Joe's AKS, the pattern already in production for Cortexplane) — one database for Ranker, one for Loop Closer. Relational tables for the canonical model (items, scores, policies, nodes, loops, ledger), JSONB for per-type attributes, append-only tables enforced by grants (no UPDATE/DELETE for the app role on ledger/score tables).

**Why:** Postgres is the most portable store there is — `pg_dump` is a complete exit, every successor system and every host can read it, and Joe's estate already operates it. The full export bundle (SPEC §A5/B5) is a designed feature built on dump + JSONL export, not an afterthought.

**Main alternative:** a document store (MongoDB) or app-platform backend (Appwrite — used elsewhere on the estate). Why not: the models are relational at their core (scores cite policies cite items; loops cite nodes cite ledger events), and Mongo/Appwrite both make the exit story worse — weaker dump tooling, more platform between Joe and his data.

## 3. Vectors: pgvector first, dedicated vector DB as escape hatch

**Recommendation:** **pgvector inside the same Postgres databases** for v1 — Ranker as its primary retrieval index, Loop Closer as an auxiliary index (identity matching, thread/message lookup, candidate next actions) in its own database. Embedding rows live in a table keyed by (item/node id, embedding_model_id, model_version), per SPEC A2.10.

**Why:** at this scale (millions of vectors at the outside) pgvector's HNSW indexes are more than sufficient, and keeping vectors beside the canonical records means one backup, one transaction boundary, one exit — a single `pg_dump` carries the whole system, vectors included-or-rebuildable.

**Main alternative:** Qdrant (dedicated vector DB) as the primary vector store. Why not *first*: it is a second stateful system to run, back up, and include in the exit story, bought for scale and filtering performance this workload does not need yet. **Escape hatch, explicitly:** because embeddings are derived and rebuildable (never the record), moving the *index* to Qdrant later is a re-indexing job, not a migration. Decide then, on measured retrieval pain, not now on speculation. (The reverse order — Qdrant first — would make the cheap thing the default and the exit the project.)

**Hard boundary (from v3, not negotiable in implementation):** Loop Closer's state machine and ledger never touch the vector index. "Is this loop open?" is answered from Postgres tables, exactly. Vectors there only suggest.

## 4. Graph: Postgres edge tables first; Neo4j as a derived projection, not the record

**Recommendation:** Typed edge tables in Postgres (SPEC A2.5 / B2.2) with recursive CTEs for traversal, in each system's own database, as the system of record for graph structure. If — and only if — Loop Closer's traversals (multi-hop causal walks over the Who/What/When graph) outgrow CTEs in latency or in query-writing pain, add **Neo4j as a rebuildable read projection**: edges replicate out of Postgres, queries run in Neo4j, nothing is ever written to Neo4j first.

**Why:** both graphs are small (Ranker's citation graph: thousands–millions of edges; Loop Closer's: a personal graph — thousands of nodes). Postgres keeps graph, ledger, and state in one transactional store, so a Loop Closer transition and the edge changes it causes commit or roll back together — the consistency property v3 calls critical. And Joe already operates Neo4j well (X knowledge graph), which is exactly why it is a low-risk *projection* option rather than an unknown.

**Main alternatives:**
- **Neo4j as Loop Closer's system of record.** Why not: it splits the transactional boundary — loop state in Postgres, graph in Neo4j, and every transition becomes a two-store coordination problem with no atomic commit. The failure mode (state says waiting, graph says closed) is precisely the "chased twice or never" class. It also adds a second exit format to the portability story.
- **Apache AGE** (Postgres extension adding openCypher graph queries). Why not: it keeps the one-store property, but it is the least finished option here — smaller community, subset Cypher, thinner tooling — and underneath, it is still Postgres tables. Plain edge tables + CTEs get v1's traversals done with zero new dependencies; AGE can be adopted later over the same tables if query ergonomics demand it.

## 5. Originals / blob storage: S3-compatible object storage on the estate

**Recommendation:** MinIO (self-hosted, S3-compatible) on Joe's AKS, one bucket per system, objects keyed by SHA-256 content hash (matching SPEC A2.2). Photos and PDFs are stored once, content-addressed; thumbnails/previews are derived objects, rebuildable, stored under a separate prefix. Multipart upload for large originals; per-object metadata lives in Postgres, not in object tags.

**Why:** the S3 API is the closest thing blob storage has to a standard — MinIO today, any S3-compatible store tomorrow, exit = copy the bucket. Content addressing gives dedup and integrity (hash = name) for free, which the provenance model already assumes.

**Main alternative:** files on a Kubernetes PVC / plain filesystem. Why not: works at first, then backup, integrity-checking, and any future move all become hand-rolled. The other alternative — a vendor blob (S3 proper, Azure Blob) as the primary store — is fine mechanically and Azure Blob on Joe's own subscription is not a *silo* in the vendor-lock-in sense, but MinIO keeps the bytes on the same estate as everything else and the API identical if they ever move. Either is defensible; MinIO is the recommendation for estate locality.

## 6. Loop Closer's When machinery: a Postgres-backed sensor, no new platform

**Recommendation:** Build the sensor as a small worker in the `loopcloser` service family:
- **Calendar Whens** are rows: `next_fire_at` computed from the schedule rule at arm time and after each firing. A tick job (AKS CronJob, every minute) asks Postgres "which armed Whens are due?" — claim-and-fire inside a transaction, writing the ledger event and advancing `next_fire_at` atomically. Missed ticks (pod down) self-heal: due is due, whenever the tick next runs.
- **Event Whens** fire through the API: `fire_event` as a webhook endpoint (for systems that can push: CI, Stripe-class sources) and via poller bindings where a source can only be polled. Every firing carries an idempotency key; the ledger's uniqueness constraint on it is what makes double-delivery harmless.
- **Side effects** (workflow runs, send requests) go through a transactional outbox table in the same Postgres: written in the same transaction as the state change, drained by the worker. No separate message broker in v1.

**Why:** timers and event triggers over a personal-scale graph are a solved problem inside Postgres + one CronJob — zero new stateful infrastructure, and the firing logic is ordinary code over Joe's own tables, fully exportable and inspectable. This must be Loop Closer's *own* machinery: it must not depend on Juno's cron or any harness being awake, because the loops have to stay true when the harness changes (that is the portability requirement applied to time).

**Main alternatives:**
- **Temporal** (finished workflow engine). Why not for v1: genuinely good software, but it is another stateful platform to operate, and workflow definitions living in Temporal's model are one more place Joe's logic gets held. Revisit if workflow runs become long, branching, and compensation-heavy beyond what templates + the outbox can express.
- **A queue/broker (NATS, Redis, RabbitMQ) as the event backbone.** Why not: same reasoning — real infra to run, bought for throughput this system will never see. The outbox pattern inside Postgres covers the reliability need (at-least-once delivery, idempotent consumers) at this scale.

## 7. Embeddings: model-agnostic, versioned, disposable

**Recommendation:**
- An `Embedder` interface inside each service: `embed(text | image) → vector`, with the provider behind config, never hard-coded into stored data.
- Every stored vector records `embedding_model_id` + `model_version` + `dims` (SPEC A2.10). Mixed-model indexes coexist during a changeover; cutover = re-embed from originals, flip the query default, drop the old rows when satisfied. A model change is an index rebuild, never a data migration.
- **Text (v1):** an API embedder behind the interface (e.g. OpenAI `text-embedding-3-small` class) for the text corpora — cheapest path to working retrieval over papers/docs, and fully replaceable because the vectors are disposable.
- **Images (photos corpus, Phase 3):** a CLIP-family open model (e.g. SigLIP) run by the batch worker on the estate, so personal photos are embedded without their bytes leaving Joe's infra.
- **Privacy note, stated plainly:** text sent to an embedding API leaves the estate. For office documents that may matter. The interface exists precisely so a self-hosted open-weight text embedder (BGE/nomic class, run by the batch worker) can replace the API embedder without touching anything else. Which embedder is used for which corpus is a per-corpus config choice — **flagged as OPEN (SPEC Q14-adjacent): Joe picks per corpus with the privacy trade-off in front of him.**

**Why this shape:** embeddings are the fastest-moving, most replaceable layer in the whole stack — models improve yearly and a successor system "might even do lookups more efficiently" (Joe, 2026-11-07). The design treats them the way the portability requirement demands: a cache with a version label.

**Main alternative:** standardise on one self-hosted embedding model for everything from day one. Why not: it makes Phase 1 wait on GPU/serving plumbing for a benefit (total locality) that only some corpora need, and an early model pick is the most likely pick to be regretted. Interface first, locality per corpus.

## 8. Language / runtime: TypeScript services, Python workers

**Recommendation:** Services (API + MCP + sensor) in **TypeScript on Node**; the embeddings/classification batch worker in **Python**.

**Why:** the estate's application code already runs TypeScript (Cortexplane et al.), the MCP SDK is most mature in TypeScript, and one language across both services keeps a one-person operation maintainable. Python is used only where its ML ecosystem is the finished tool (embedding models, image processing, PDF handling) — as a worker that calls the same APIs, not as a second service stack.

**Main alternative:** all-Python (FastAPI) services. Why not: perfectly workable, but it splits the estate's language centre of gravity and has the weaker MCP story; nothing in these systems needs Python at the service layer. All-TypeScript including ML workers was also considered — rejected for the worker layer only, because self-hosted embedding/image models are Python-native in practice.

## 9. Identity, auth, secrets

**Recommendation:** Per-agent API keys (one per named agent principal — Juno, Hermes, a future successor) with per-system, per-operation scopes (SPEC §4: an intake agent can `capture` and cannot `classify_commit` or `score`), keys custodied in OpenBao (the estate standard), services validating keys directly. Joe's own access uses the same mechanism with full scope. MCP servers take the same key as the REST API — one identity, two dialects.

**Why:** the access model is part of the design (propose vs commit vs score are different principals' powers), so identity has to be in the service, not bolted onto a harness. OpenBao is already where the estate's secrets live.

**Main alternative:** OAuth/OIDC with a full identity provider. Why not: correct at multi-user scale, oversized for a single-operator internal platform; revisit only if SPEC Q10 (users beyond Joe) is ever decided yes.

## 10. Hosting, deploy, backup, exit

- **Hosting:** Joe's AKS (aks-obs-01 family), one namespace per system; CNPG Postgres clusters per system; MinIO on the same estate. Deployed via the estate's GitOps + Argo Rollouts blue/green standard (DV-61) — no new deploy machinery.
- **Not** a vendor cloud silo: no hosted vector DB SaaS, no vendor memory product, no serverless store whose export is an API trickle. (Ordinary cloud *compute/storage under Joe's own accounts* is the estate already; the line drawn here is against stores he cannot dump wholesale.)
- **Backup:** nightly `pg_dump` per database + bucket sync of the object stores to a second location under Joe's control; retention per estate norms. Backups are tested by restore, not by job-green status.
- **Exit as a feature:** the `export` operation (SPEC §A5/B5) is a first-class, scheduled job — a fresh portable bundle produced regularly, so "can I leave?" is never a project. The **restore drill is the goldfish test**: restore the bundle into an empty environment, point a fresh harness at it, ask the cold questions. If that drill passes, portability is a fact, not a promise. Joe's replace trigger (really cheap **and** way better) is executable precisely because this drill exists.

## 11. Cost and complexity, honestly

- **New running components:** 2 small services, 2 MCP adapters (thin), 1 batch worker, 1 sensor worker, 2 Postgres databases (on existing CNPG operations), 1 MinIO deployment. No new platform-class software (no Temporal, no broker, no new database engine).
- **Marginal infrastructure cost:** small — everything rides the existing AKS estate; the only metered external spend in the proposal is optional text-embedding API calls, which are cheap at this corpus scale and removable per corpus.
- **The real cost is build and upkeep time — Joe's and his agents'.** That is the honest argument for every "boring" choice above: Postgres over a novel store, pgvector over a new service, edge tables over a graph platform, CronJob + outbox over a workflow engine. Each declined component is a thing one person does not have to patch at 1am.
- **Deliberate under-building:** no UI, no multi-user auth, no workflow engine, no dedicated vector DB in v1. Each has a named trigger for revisiting (retrieval pain → Qdrant; traversal pain → Neo4j projection; workflow complexity → Temporal; Q10 decided yes → real identity). Under-building with named exits beats over-building on speculation — and matches the phased, dogfood-first order in the SPEC.
- **Ray (evaluated 2026-11-07, Joe asked):** NOT in v1, named as an escape hatch in the same pattern. Ray (2.60.0, Nov 2026) is a finished, general distributed-compute framework for Python/AI workloads — Ray Data for batch pipelines, Ray Serve for model serving, Core tasks/actors, runs on Kubernetes via KubeRay. Fit: it belongs, if anywhere, inside Corpus Ranker's Python batch worker only — bulk backfills (initial photo-archive and office-doc ingestion: embed + classify tens of thousands of items in parallel) and self-hosted model serving (embeddings / image classification behind Ray Serve, which would also serve the Q14 privacy preference for not sending documents to an external API). Non-fit: Loop Closer (small, live, transactional — distributed compute machinery has nothing to offer exact state transitions, and would reintroduce the platform-in-the-loop failure class); Ranker's daily steady-state (~200 papers/day embeds in minutes on one worker — Ray solves a scale this system does not have). Cost if adopted early: a second stateful platform to operate (head node, object store, autoscaling config) bought on speculation. Trigger to revisit: a measured backfill or re-embedding job that a single worker cannot finish in an acceptable window, or self-hosted model serving becoming a real requirement. Because the batch worker is a replaceable component behind the API, adopting Ray later is a worker swap, not a redesign.

## 12. Decision summary

| Choice | Recommendation (proposal) | Main alternative | Why not the alternative |
|---|---|---|---|
| Service surface | REST API + thin MCP adapter | MCP only | MCP-only couples the store to one protocol |
| System of record | PostgreSQL (CNPG), separate DB per system | Mongo / Appwrite | Relational core; pg_dump is the best exit there is |
| Vectors | pgvector in Postgres | Qdrant | Second stateful system for scale we don't have; re-indexing makes it a cheap later move |
| Graph | Postgres edge tables + CTEs; Neo4j only as derived projection if needed | Neo4j as record / Apache AGE | Two-store transactions break loop consistency / AGE is the least finished option |
| Originals | MinIO (S3 API), content-addressed | PVC filesystem / vendor blob primary | Hand-rolled backup/integrity / estate locality |
| When machinery | Postgres rows + AKS CronJob tick + transactional outbox | Temporal / message broker | Platform weight and logic lock-in at personal scale |
| Embeddings | Pluggable interface; API text embedder v1, self-hosted CLIP-family for images; all vectors versioned + disposable | One self-hosted model for everything, day one | Delays Phase 1 for locality only some corpora need |
| Language | TypeScript services, Python ML workers | All-Python | Estate centre of gravity + MCP maturity |
| Identity | Per-agent scoped API keys, OpenBao custody | Full OIDC provider | Oversized until/unless users-beyond-Joe is decided |
| Hosting | Joe's AKS + GitOps/Argo standard | Vendor SaaS stores | Portability is the point |

All rows are **proposals** (SPEC OPEN QUESTION Q14). Joe decides the stack; this document's job is to make that decision cheap to make and safe to change — which, given the exit drills in §10, it is.
