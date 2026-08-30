-- 0015_otel_trace_ids.sql
--
-- Add trace_id / span_id columns to high-volume telemetry tables
-- so that ClickHouse rows can be correlated with OpenTelemetry distributed
-- traces in any OTEL-compatible backend (Jaeger, Honeycomb, Tempo, etc.).
--
-- Design:
--   - Empty string default ('') is the canonical "no active trace" sentinel.
--     Callers stamp these via currentTraceIds() from @oxagen/telemetry/tracer.
--   - String (not FixedString) to support both 32-char trace ids and
--     16-char span ids without schema fragility; LowCardinality would not
--     help here since cardinality is high (one per span).
--   - ADD COLUMN IF NOT EXISTS: idempotent; safe on any replica set.
--
-- Tables amended:
--   token_usage       — LLM call rows (log↔trace join for cost attribution)
--   tool_invocations  — tool execution rows (latency + error tracing)
--   events            — general event stream rows (cross-service correlation)
--
-- TTL and sort keys are unchanged.

-- token_usage: stamp each LLM call with the enclosing kernel / stream span
ALTER TABLE token_usage
    ADD COLUMN IF NOT EXISTS trace_id String DEFAULT '',
    ADD COLUMN IF NOT EXISTS span_id  String DEFAULT '';

-- tool_invocations: stamp each tool call with the enclosing kernel span
ALTER TABLE tool_invocations
    ADD COLUMN IF NOT EXISTS trace_id String DEFAULT '',
    ADD COLUMN IF NOT EXISTS span_id  String DEFAULT '';

-- events: stamp general event bus rows with the emitting span context
ALTER TABLE events
    ADD COLUMN IF NOT EXISTS trace_id String DEFAULT '',
    ADD COLUMN IF NOT EXISTS span_id  String DEFAULT '';
