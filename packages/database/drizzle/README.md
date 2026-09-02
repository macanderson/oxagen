# drizzle/ — retired migration archive. Do not add files here.

**Nothing in this folder runs.** These SQL files are kept only as a record of
how the Postgres schema got to its 2026-06 shape. No script reads them, no CI
job applies them, and no database is built from them.

## Where migrations live now

Postgres migrations live in **`packages/database/atlas/migrations/`** and are
applied by the Atlas CLI:

```bash
cd packages/database
atlas migrate diff --env local "describe_your_change"   # write a new migration
atlas migrate apply --env local                         # apply pending ones
atlas migrate hash --dir "file://atlas/migrations"      # refresh atlas.sum
```

`pnpm db:migrate` from the repo root runs Atlas for Postgres and then
`tools/scripts/db-migrate.ts` for ClickHouse and Neo4j. Neither one opens this
folder.

## Why the headers in these files are wrong

Several files here say they are "Applied by: pnpm db:migrate via
public._migrations". That was true when they were written. It is not true now:

- The `public._migrations` table belonged to a custom runner that was replaced
  by Atlas. `atlas.hcl` lists it under `exclude`, so Atlas ignores it.
- `tools/scripts/db-migrate.ts` now only handles ClickHouse and Neo4j.

Read the headers as history, not as instructions.

## One thing still points here

`tools/scripts/db-lint-migrations.ts` still scans this folder for naming and
numbering problems, and `pnpm db:lint-migrations` is part of `pnpm gate`. That
check has no effect on any live database — it guards a frozen archive. It is
also the reason this folder cannot simply be deleted: removing it would make
the gate fail. Retiring the check and the folder together is a follow-up.
