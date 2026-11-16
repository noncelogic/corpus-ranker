# 0001 — The service reaches Postgres through an in-process client

Date: 2026-11-16 · Task: CR-M3-PGCLIENT · Status: adopted (pending owner
approval of the new dependency on the PR, docs/EXTERNAL-REVIEW.md §3)

## Context

The CR-M3-T1 review (COND-92-review2, 2026-11-16) found that the service's
database adapter, `src/db/psql.ts`, ran every database call by spawning the
`psql` CLI and splicing values into SQL text as escaped literals. The final
service image is not meant to carry a Postgres client binary, so the shipped
service's default capture path failed with `ENOENT` and answered HTTP 500.
The tests passed anyway because the test host had `psql` on `PATH`.

Postgres is the decided system of record (TECH-STACK.md §2). A service that
cannot reach its store from its own image cannot capture, score or rank.

## Decision

1. The service talks to Postgres over the wire protocol through a packaged,
   in-process Node client: **postgres.js** (`postgres` on npm), pinned
   exactly at **3.4.9**, the only runtime dependency.
2. All database access goes through `src/db/client.ts`:
   - `query(text, params)` sends one statement with its values as bound
     protocol parameters (`$1`, `$2`, …). Values are never spliced into SQL
     text. Parameters are scalars (`string | number | boolean | null`); JSON
     is sent as its text with a `::jsonb` cast, exactly as libpq sends it.
     json/jsonb result columns are parsed.
   - `transaction(fn)` runs `fn` on one connection inside `BEGIN … COMMIT`,
     and rolls back when `fn` rejects.
3. No code path spawns `psql`: not the service, and not the operator
   export/restore CLI (`src/export/`, `npm run export|restore`). The service
   image no longer installs `postgresql17-client`; it installs the lockfile's
   runtime dependencies (`npm ci --omit=dev`).
   - Export holds one read-only repeatable-read transaction on the client,
     exports its snapshot, runs `pg_dump --snapshot` on it and reads the
     schema version and JSONL inside the same transaction, as before. The
     JSONL rows are read as the JSON objects' text, so bundle files are
     byte-for-byte what they were.
   - Restore runs the emptiness check, the role preamble, the dump and the
     verification in one client transaction, which rolls back on any error,
     leaving the target as found.
   - The dump is the one external program left: `pg_dump` has no in-process
     equivalent, and only the operator CLI uses it. It is taken with
     `--inserts`, so `database.sql` is plain SQL the client can send.
     `COPY … FROM stdin` blocks (inline data only `psql` can feed) are
     refused with a clear error. `pg_dump`'s `\restrict`/`\unrestrict` lines
     guard `psql` itself and are dropped.
4. The adapter's tests (`tests/db/client.test.ts`), the capture API tests
   and the export/restore tests take `psql` off the test process's `PATH`
   before the code under test touches the database, and
   `tests/db/no-psql-source.test.ts` fails if any source file names `psql`
   as a program. The test host therefore cannot supply what the image lacks. The
   fixtures' own setup SQL still runs `psql` inside the Postgres container
   (`docker compose exec`), which is outside the code under test.

## What does not change

- **Query results.** Capture issues the same SQL with the same JSON shape, and
  the HTTP responses are unchanged. The statement is still a single statement,
  so it still runs in one implicit transaction, with the same insert-or-return
  and retry-once behaviour.
- **Grants.** The service connects as its login, which is granted
  `ranker_app` (CR-D1). The app role's append-only grants
  (`db/migrations/0001_corpus_model.sql`) are untouched. The client tests show
  that through the client the login can append, and cannot update or delete
  append-only rows or create tables.

## Why postgres.js

- **Supply chain.** It has zero transitive dependencies, so the lockfile gains
  exactly one package. The usual alternative, `pg` (node-postgres), brings in
  roughly a dozen packages (`pg-pool`, `pg-protocol`, `pg-types`, `pgpass` and
  their dependencies). Each of those is something docs/EXTERNAL-REVIEW.md §3
  says must be reviewed line by line.
- **Maturity.** 3.4.x is a long-lived release line (3.4.0 shipped in 2023).
  3.4.9 was published on 2026-04-05. The 4.x line first shipped on
  2026-10-29, and its latest release (4.1.1, 2026-11-11) is days old, so it
  was not chosen.
- **Fit.** It ships its own TypeScript types and an ESM entry point, and
  supports parameterised raw-text queries (`sql.unsafe(text, params)`) and
  scoped transactions (`sql.begin`). The name `unsafe` refers only to the SQL
  *text* being raw. Values still travel as bound parameters.
- **Maintainer.** Rasmus Porsager (porsager/postgres on GitHub). License:
  Unlicense.

## Known footgun handled

By default postgres.js `JSON.stringify`s any value bound to a json/jsonb
parameter, so JSON text bound to `$n::jsonb` would be stored as a JSON
*string*. That breaks `jsonb_typeof(...) = 'object'` checks. The adapter
overrides the json serializer so text passes through unchanged. The client
test pins this behaviour.

## Out of scope / follow-ups

- The export/restore CLI still needs `pg_dump` on the operator's host (see
  decision 3).
- Pool sizing (`max: 10`) and timeouts are defaults, not tuned against
  production load.
