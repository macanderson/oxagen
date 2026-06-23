-- 0009_perf_optimizations.sql
--
-- ClickHouse performance pass (perf/db-schema-audit). SAFE, additive-only:
-- data-skipping indexes on hot secondary filters + a missing TTL. No column
-- type changes, no ORDER BY changes, no drops (those need table rebuilds and
-- are tracked as proposals in the audit report).
--
-- Each ADD INDEX applies to *new* parts automatically. Because these telemetry
-- tables are MergeTree (not Replicated) and currently small, applying the index
-- to historical parts is a manual follow-up: run
--   ALTER TABLE <t> MATERIALIZE INDEX <name>;
-- once, off the write path, when convenient. We do NOT MATERIALIZE here so the
-- migration never triggers a synchronous part rewrite on deploy.
--
-- All statements are idempotent (ADD INDEX IF NOT EXISTS / MODIFY TTL).

-- audit_events: latestAuditChainHash() filters `WHERE org_id = X AND
-- capability = Y` but `capability` is NOT in the ORDER BY key
-- (org_id, occurred_at, event_id) — every chain-hash read scans all of the
-- org's audit rows across every capability. A `set` skip index on the
-- low-cardinality capability column lets ClickHouse prune granules that don't
-- contain the target capability. set(0) = unbounded distinct set per granule;
-- capability is LowCardinality so the set stays tiny.
ALTER TABLE audit_events
  ADD INDEX IF NOT EXISTS idx_audit_capability capability TYPE set(0) GRANULARITY 4;

-- tool_invocations: ORDER BY leads with capability_name, so capability lookups
-- are already fast. The two common *secondary* filters are status (failed-call
-- dashboards) and message_id (per-message trace expansion), neither of which
-- leads the key. A set index on the low-cardinality status enum and a
-- bloom_filter on the high-cardinality message_id prune granules for those
-- scans.
ALTER TABLE tool_invocations
  ADD INDEX IF NOT EXISTS idx_tool_status status TYPE set(0) GRANULARITY 4;

ALTER TABLE tool_invocations
  ADD INDEX IF NOT EXISTS idx_tool_message_id message_id TYPE bloom_filter(0.01) GRANULARITY 4;

-- token_usage: sumTokenUsage filters by (org_id, created_at) which the primary
-- key already serves. The known upcoming need is cost/usage rollups grouped by
-- model (per-model pricing lands with the agent epic — see clickhouse.ts). model
-- is LowCardinality and not in the key; a set index prunes granules for
-- model-filtered analytics without touching the hot billing aggregate.
ALTER TABLE token_usage
  ADD INDEX IF NOT EXISTS idx_token_model model TYPE set(0) GRANULARITY 4;

-- skill_loads: the only raw telemetry table with NO TTL — it grows unbounded.
-- readSkillMetrics aggregates loads + last_used, so the data has long-tail
-- value; match token_usage's billing-grade 365-day retention rather than the
-- 90-day raw-log window. created_at is plain DateTime here (not DateTime64), so
-- no toDateTime() cast is needed.
ALTER TABLE skill_loads
  MODIFY TTL created_at + INTERVAL 365 DAY;
