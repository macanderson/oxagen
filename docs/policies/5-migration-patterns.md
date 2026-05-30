# 5. Migration Patterns

- Migrations are forward-only and expand-then-contract. Never edit a shipped migration; add a new one.
- Two-phase for breaking changes:
  1. Expand: add the new column/table/constraint as nullable or additive, backfill, dual-write.
  2. Contract: in a later migration, after deploy and backfill verify, drop the old shape.
- Every migration is reversible in intent and tested against a copy of production-shape data before merge.
- No destructive operation (drop column, drop table, type narrowing) in the same migration that introduces its replacement.
- Backfills are batched and idempotent. A re-run does not corrupt or double-apply.
- Migrations run in CI against a fresh database and against a snapshot with representative data. A migration that fails either gate does not merge.
- One logical change per migration file. No bundling unrelated schema edits.
