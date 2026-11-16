# Committed export bundles

Bundles exported once and committed, so restore keeps loading them whatever
the exporter or the restore path later becomes
(`tests/export/restore.test.ts`). Never regenerate or edit one in place: its
point is that it is old. A new bundle encoding gets a new directory beside it.

## bundle-v1-copy

A version-1 bundle (`bundle_version: 1`, schema version 2) written by the
exporter as of commit 5e65122, before `--inserts`: `database.sql` is a plain
`pg_dump --format=plain --no-owner --exclude-table-data=embeddings`
(pg_dump 17.8, the compose replica's) whose table data is
`COPY ... FROM stdin` blocks, with the `\restrict` / `\unrestrict` lines
pg_dump 17.6+ writes. The data is the seed of
`tests/export/export-bundle.test.ts` (every A2 table; a newline, a backslash,
unicode and quotes in text) with item `cr_item_p2` titled `Paper<TAB>Two`, so
the COPY rows carry `\n`, `\\`, `\t` and `\N` escapes. `exported_at` was
pinned to 2026-11-16T00:00:00.000Z.

It was produced by running that commit's `exportBundle` over a
`freshDatabase` seeded with that SQL, with no change to the commit's source.
