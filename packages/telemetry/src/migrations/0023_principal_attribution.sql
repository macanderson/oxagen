-- 0023_principal_attribution.sql
--
-- Principal-to-data spine (Epic 1, docs/specs/top3-wedge-gap-epics.md).
-- `token_usage` and `tool_invocations` carried org/workspace tenancy but no
-- record of WHO drove the spend: which IAM principal acted, what kind of
-- principal it was (human | agent | service), which human user originated
-- the request, and (for token_usage) which capability the tokens were spent
-- inside. Without those dimensions, per-seat / per-agent / per-capability
-- metering is structurally impossible — the known `principal_id` P0.
--
-- Values are stamped at the single insert boundary in @oxagen/telemetry
-- (insertTokenUsage / insertToolInvocation) from the ambient tenant scope
-- (@oxagen/tenancy getPrincipalAttribution) — the same ambient-stamping
-- pattern as the OTEL trace_id/span_id columns (0015).
--
-- Sentinels follow the four-store conventions: nil UUID = "no principal
-- resolved" / "no originating user" (same as workspace_id and
-- execution_step_id), empty string = "no kind" for the LowCardinality
-- column. None of the new columns is part of a sort key, so plain ADD
-- COLUMN is legal.
--
-- Idempotent ALTERs (this migrations dir re-applies every file on every
-- run; see migrate.ts) — ADD COLUMN / ADD INDEX guarded by IF NOT EXISTS.

ALTER TABLE token_usage
  ADD COLUMN IF NOT EXISTS principal_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000');

ALTER TABLE token_usage
  ADD COLUMN IF NOT EXISTS principal_kind LowCardinality(String) DEFAULT '';

ALTER TABLE token_usage
  ADD COLUMN IF NOT EXISTS user_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000');

ALTER TABLE token_usage
  ADD COLUMN IF NOT EXISTS capability_name LowCardinality(String) DEFAULT '';

-- Per-capability cost rollups prune granules the same way per-model ones do
-- (mirrors idx_token_model from 0009). Applies to new parts only — reads are
-- correct without it, so no MATERIALIZE INDEX mutation is run.
ALTER TABLE token_usage
  ADD INDEX IF NOT EXISTS idx_token_capability capability_name TYPE set(0) GRANULARITY 4;

-- Point lookups "what did principal X spend" within an org partition.
ALTER TABLE token_usage
  ADD INDEX IF NOT EXISTS idx_token_principal principal_id TYPE bloom_filter(0.01) GRANULARITY 4;

ALTER TABLE tool_invocations
  ADD COLUMN IF NOT EXISTS principal_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000');

ALTER TABLE tool_invocations
  ADD COLUMN IF NOT EXISTS principal_kind LowCardinality(String) DEFAULT '';

ALTER TABLE tool_invocations
  ADD COLUMN IF NOT EXISTS user_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000');

ALTER TABLE tool_invocations
  ADD INDEX IF NOT EXISTS idx_tool_principal principal_id TYPE bloom_filter(0.01) GRANULARITY 4;
