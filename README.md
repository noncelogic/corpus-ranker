# Corpus Ranker (working title — name not final)

Joe Graham's personal corpus platform: it captures material, classifies it into canonical items, scores it under versioned policies (rubrics/criteria), and ranks it into explainable Top-N views — in Joe's words, "capturing, classifying and ranking."

Internal-first: built for Joe's own corpora and dogfooded on them. Externalisation is undecided — a premise-class decision that has not been made.

Documents in this folder:
- `INTENDED-USE.md` — founder-approved intended use (Joe Graham, 2026-11-07)
- `DEFINITIONS.md` — governing refined definitions (shared document, also filed under `projects/loop-closer/`)
- `SPEC.md` — buildable spec (covers both Corpus Ranker and Loop Closer)
- `TECH-STACK.md` — the decided tech stack (2026-11-07)

Project record: the canonical charter, spec, and plan for this project live in the meta-harness `projects/corpus-ranker/` folder; this repository is its code home.

## Development

Requirements: Node.js 24+, Docker with the Compose plugin.

```sh
npm ci                 # install (TypeScript toolchain only)
npm run build          # compile the ranker service skeleton to dist/
npm start              # run it; GET /healthz answers {"status":"ok","service":"ranker"}
npm run typecheck      # tsc, strict
npm run lint           # tsc with unused-code checks
npm test               # full suite (node:test); needs Docker for the replica test
```

### Local replica

`docker compose up -d --wait` (or `npm run replica:up`) boots the ranker's
deployment shape locally: Postgres 17 with pgvector holding the `ranker`
database, and MinIO (S3 API) holding the `ranker-originals` bucket. Host
ports default to 5432 / 9000 / 9001 and can be overridden with
`RANKER_PG_PORT`, `RANKER_MINIO_PORT`, `RANKER_MINIO_CONSOLE_PORT`.
`docker compose down -v` (or `npm run replica:down`) removes it and its data.
Credentials in `docker-compose.yaml` are local throwaways, not estate secrets.
