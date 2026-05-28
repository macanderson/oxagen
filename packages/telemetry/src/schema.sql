-- Spec §7. Append-only telemetry. Monthly partitions, 90-day TTL on raw
-- tables, materialized rollups retained longer (added in later migrations).

CREATE TABLE IF NOT EXISTS execution_logs (
  execution_id UUID,
  step_id UUID,
  tenant_id UUID,
  workspace_id UUID,
  log_level LowCardinality(String),
  message String,
  metadata String,
  created_at DateTime64(3)
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (tenant_id, execution_id, created_at)
TTL toDateTime(created_at) + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS traces (
  trace_id String,
  execution_id UUID,
  tenant_id UUID,
  started_at DateTime64(3),
  completed_at Nullable(DateTime64(3))
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(started_at)
ORDER BY (tenant_id, trace_id, started_at)
TTL toDateTime(started_at) + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS spans (
  span_id String,
  trace_id String,
  parent_span_id Nullable(String),
  span_type LowCardinality(String),
  tenant_id UUID,
  started_at DateTime64(3),
  completed_at Nullable(DateTime64(3)),
  metadata String
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(started_at)
ORDER BY (tenant_id, trace_id, started_at)
TTL toDateTime(started_at) + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS events (
  event_id UUID,
  tenant_id UUID,
  workspace_id UUID,
  event_type LowCardinality(String),
  source_system LowCardinality(String),
  stream_offset Nullable(String),
  payload String,
  emitted_at DateTime64(3)
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(emitted_at)
ORDER BY (tenant_id, event_type, emitted_at)
TTL toDateTime(emitted_at) + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS api_key_events (
  api_key_id UUID,
  tenant_id UUID,
  ip_address IPv6,
  user_agent String,
  request_path String,
  response_code UInt16,
  created_at DateTime64(3)
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (tenant_id, api_key_id, created_at)
TTL toDateTime(created_at) + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS token_usage (
  execution_step_id UUID,
  tenant_id UUID,
  workspace_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  model LowCardinality(String),
  provider LowCardinality(String) DEFAULT '',
  input_tokens UInt64,
  output_tokens UInt64,
  cached_tokens UInt64,
  cost_usd_micros UInt64,
  duration_ms UInt32 DEFAULT 0,
  surface LowCardinality(String) DEFAULT '',
  prompt_hash String DEFAULT '',
  created_at DateTime64(3)
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (tenant_id, created_at, execution_step_id)
-- Token usage retained longer than raw logs: billing recomputation
-- and dispute investigation routinely reach beyond 90 days.
TTL toDateTime(created_at) + INTERVAL 365 DAY;

-- Agent runtime epic (spec §6, §9). Separate from Postgres
-- execution.tool_calls (the durable record); this is the analytics-side
-- mirror for high-volume agent fanouts.
CREATE TABLE IF NOT EXISTS tool_invocations (
  invocation_id UUID,
  tenant_id UUID,
  workspace_id UUID,
  capability_name LowCardinality(String),
  message_id UUID,
  parent_message_id Nullable(UUID),
  execution_step_id Nullable(UUID),
  status LowCardinality(String),
  input_size_bytes UInt32,
  output_size_bytes UInt32,
  latency_ms UInt32,
  error_class Nullable(String),
  external_provider LowCardinality(String) DEFAULT '',
  external_server_id Nullable(UUID),
  risk_level LowCardinality(String),
  required_approval UInt8,
  surface LowCardinality(String) DEFAULT '',
  provider LowCardinality(String) DEFAULT '',
  created_at DateTime64(3)
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (tenant_id, capability_name, created_at)
TTL toDateTime(created_at) + INTERVAL 180 DAY;
