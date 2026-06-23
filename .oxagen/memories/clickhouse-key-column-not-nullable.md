---
name: clickhouse-key-column-not-nullable
type: observation
domain: telemetry
severity: P2
date: 2026-06-23
---

**Observation:** A ClickHouse `MergeTree` sorting-key column CANNOT be converted
to `Nullable` after table creation. `ALTER TABLE … MODIFY COLUMN <key> Nullable(T)`
fails with `Code 524 ALTER_OF_COLUMN_IS_FORBIDDEN` ("can change the representation
of primary key"), and this holds **even after** `ALTER TABLE … MODIFY SETTING
allow_nullable_key = 1` (that setting only takes effect at CREATE time).
Empirically verified against ClickHouse 24.8 (the version `pnpm dev` runs locally,
`clickhouse/clickhouse-server:24.8-alpine`).

**Why it matters here:** the telemetry migration convention is "mirror the prior
nullable fix" (migration 0004 made `execution_logs.step_id` Nullable). But that
only worked because `step_id` is NOT in `execution_logs`'s `ORDER BY`. Blindly
mirroring it for a KEY column (e.g. `token_usage.execution_step_id`, which is in
`ORDER BY (org_id, created_at, execution_step_id)`) ships a migration that the
CI/prod migrate step rejects — a broken deploy. Issue ClickHouse#42083 also warns
that forcing such a conversion can corrupt the key column's stored data.

**The pattern to use instead:** keep the key column non-nullable and use a typed
SENTINEL for "absent" — the nil UUID `00000000-0000-0000-0000-000000000000` for
UUID keys (already the convention for `token_usage.workspace_id DEFAULT
toUUID('0…0')`), coalesced from `null` at the single insert boundary in
`packages/telemetry/src/clickhouse.ts`. A true Nullable key would require a full
table rebuild (`CREATE … SETTINGS allow_nullable_key = 1` + `INSERT … SELECT` +
`RENAME`) — only justified if a query actually needs to distinguish NULL.

**How to verify any telemetry schema change before writing the migration:** the
local CH is reachable — `docker exec oxagen-v2-clickhouse clickhouse-client
--query "…"`. Prototype the exact ALTER on a throwaway table mirroring the real
key structure; a green prototype is the only proof the migrate step won't fail in
CI/prod. `packages/telemetry/src/migrate.ts` runs `schema.sql`
(CREATE-IF-NOT-EXISTS) then every numbered `migrations/*.sql` (ALTERs) on each
run; `splitStatements()` strips comment lines, so a comment-only `.sql` file is a
clean no-op (useful for recording a decision in migration history).
