-- 0022_error_events_execution_id.sql
--
-- Adds execution / step correlation to the append-only `error_events` stream
-- (created in 0020_error_events.sql). error_events shipped with only the OTEL
-- trace_id/span_id for correlation, but those are empty whenever OTEL is not
-- initialised or no span is active — an unreliable join key for the common
-- agent-run case. The structured `agent.debug.trace` capability
-- (debug_with_trace) needs to pull every error captured for a specific agent
-- execution deterministically, so we stamp the execution id (and the step id
-- when known) directly on the row.
--
-- Idempotent ALTERs (this migrations dir re-applies every file on every run;
-- see migrate.ts) — ADD COLUMN / ADD INDEX guarded by IF NOT EXISTS.
--
-- Sentinels mirror the rest of the four-store model: execution_id defaults to
-- the nil UUID ("no execution scope", same convention as org_id/workspace_id
-- and token_usage.execution_step_id), and step_id is Nullable(UUID) ("no step",
-- same convention as execution_logs.step_id). captureError() coalesces at the
-- single insert boundary so a non-UUID string can never reach either column.
--
-- Neither column is part of the sort key (ORDER BY (org_id, source,
-- created_at)), so a plain ADD COLUMN is legal here (unlike a key column).

ALTER TABLE error_events
  ADD COLUMN IF NOT EXISTS execution_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000');

ALTER TABLE error_events
  ADD COLUMN IF NOT EXISTS step_id Nullable(UUID);

-- Data-skipping index so the debug read (WHERE org_id = … AND execution_id = …)
-- prunes granules within an org partition instead of scanning it. bloom_filter
-- matches the existing idx_error_fingerprint. Only applies to parts written
-- after this migration; no MATERIALIZE INDEX mutation is run (the table is
-- young and the index is a pure optimisation — reads are correct without it).
ALTER TABLE error_events
  ADD INDEX IF NOT EXISTS idx_error_execution execution_id TYPE bloom_filter(0.01) GRANULARITY 4;
