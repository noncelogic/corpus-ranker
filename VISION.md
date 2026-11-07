# Vision — Corpus Ranker (working title)

Corpus Ranker captures material, classifies it into canonical items, scores it
under versioned policies, and ranks it into explainable Top-N views. In the
owner's words: **capturing, classifying and ranking.**

## The problem it solves

Anyone who works with an AI agent over months accumulates two kinds of state
that actually matter:

1. **A ranked corpus** — the material you have gathered, with what is relevant
   to you, and why, made explicit.
2. **Open loops** — who owes what, since when, and what event closes it
   (that is the sister project, [Loop Closer](https://github.com/noncelogic/loop-closer)).

Transcripts and chat history are not the asset. The ranked corpus and its
relevance are. Today that state lives inside whichever LLM provider's harness
you happen to use, in a form you cannot take with you. Corpus Ranker exists so
the state is **owned data**: policies, score events with reasons,
classification and citation edges — stored outside any harness, in exportable
form, on the owner's own infrastructure. AI harnesses (any vendor's, and the
owner's own agents) are interchangeable readers. Switching harness means
re-pointing, not migrating.

## What it is

- A personal corpus platform, **internal-first**: built for the owner's own
  corpora and dogfooded on them — research papers, funding opportunities,
  jobs and salary data, experiment backlogs, office documents, personal
  photos, and more.
- Scoring is not ranking is not sorting. Scores are append-only evaluative
  objects produced under a versioned policy; a ranking is a derived,
  explainable view over scores. Nothing is silently overwritten —
  supersession and retraction are explicit events.

## What it is not

- Not a CRM, a notes app, or a chat-history store.
- Not a hosted product. Whether this is ever offered to anyone else is a
  separate decision that has **not** been made. This repository is public for
  transparency, not as a product launch.
- Not tied to any model or harness vendor, by design.

## Status and rights

This project is under active design and early build by its owner. **No
license has been granted** for the contents of this repository; all rights
are reserved. See [CONTRIBUTING.md](CONTRIBUTING.md) for the current terms
under which issues and pull requests are handled, and
[INTENDED-USE.md](INTENDED-USE.md) for the owner's governing statement of
what this system is for.
