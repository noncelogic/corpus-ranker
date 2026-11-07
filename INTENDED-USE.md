# INTENDED USE — Corpus Ranker (working title)
Owner: Joe Graham · Status: Founder-approved — Joe Graham, 2026-11-07
Governing definitions: DEFINITIONS.md · Buildable spec: SPEC.md · Stack: TECH-STACK.md

## What this is
Corpus Ranker is Joe Graham's personal corpus platform: it captures material, classifies it into canonical items, scores it under versioned policies (rubrics/criteria), and ranks it into explainable Top-N views. In Joe's words: "capturing, classifying and ranking."

It is one of the two key operations Joe (2026-11-07) identified as what anyone would care about taking with them from one LLM provider to the next — a ranked corpus with its relevance intact — and, with Loop Closer, part of what he calls "the software that's going to run my life."

## Intended use
- Internal-first: built for Joe's own corpora, dogfooded on them. Externalisation is a separate premise-class decision that has NOT been made; silence does not make this a product for anyone else.
- Confirmed recurring corpora (Joe, 2026-11-07): research papers; investors & funding opportunities; jobs + salary data; experiment backlog / harness traces; social research gathered for reports; solo-founder / big-ideas landscape; and "much much more."
- Joe's own material is first-class corpus: all office documents the agent tracks and all personal photos, classified and ranked for subject-area lookup. Item types are multimodal from the start.
- Relevance is explicit owned data — policies, score events with reasons, classification and citation edges — never a model's implicit synthesis. The system of record lives outside any AI harness, on Joe's estate, in exportable form; harnesses (including Juno/Muse) are replaceable readers. Switching harness = re-pointing, not migrating.
- Scoring ≠ ranking ≠ sorting: scores are append-only evaluative objects under a versioned policy; ranking is a derived, explainable view over scores; nothing is ever silently overwritten — supersession and retraction are explicit events.

## Not intended use
- Not a CRM, not a notes app, not a chat-history store. Transcripts and saved facts are not the asset; the ranked corpus and its relevance are.
- Not a system whose state may live inside a frontier lab's harness or any vendor silo.
- No kill criteria: this is infrastructure Joe intends to run his life on. The only exit is replacement by a service that is both really cheap AND way better (Joe, 2026-11-07) — which the portability design makes an import, not a loss.
