-- Migration 0000 / baseline. This file is re-applied idempotently on every
-- migrate() run (all statements use CREATE TABLE IF NOT EXISTS). Numbered
-- migrations in migrations/ start at 0002 because 0001 was folded into this
-- baseline before versioned tracking began. Add new columns or tables via a
-- new numbered migration file; do not edit this baseline.
--
-- Spec §7. Append-only telemetry. Monthly partitions, 90-day TTL on raw
-- tables, materialized rollups retained longer (added in later migrations).

CREATE TABLE IF NOT EXISTS execution_logs (
  execution_id UUID,
  -- Nullable: tool.before/after log lines (and any capability not running
  -- inside an execution step) have no step id. A non-nullable UUID forced
  -- callers to send "" — which ClickHouse's UUID text parser cannot parse,
  -- greedily over-reading into org_id and failing the whole row insert
  -- (CANNOT_PARSE_INPUT_ASSERTION_FAILED). NULL is the correct "no step".
  step_id Nullable(UUID),
  org_id UUID,
  workspace_id UUID,
  log_level LowCardinality(String),
  message String,
  metadata String,
  created_at DateTime64(3)
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (org_id, execution_id, created_at)
TTL toDateTime(created_at) + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS traces (
  trace_id String,
  execution_id UUID,
  org_id UUID,
  started_at DateTime64(3),
  completed_at Nullable(DateTime64(3))
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(started_at)
ORDER BY (org_id, trace_id, started_at)
TTL toDateTime(started_at) + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS spans (
  span_id String,
  trace_id String,
  parent_span_id Nullable(String),
  span_type LowCardinality(String),
  org_id UUID,
  started_at DateTime64(3),
  completed_at Nullable(DateTime64(3)),
  metadata String
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(started_at)
ORDER BY (org_id, trace_id, started_at)
TTL toDateTime(started_at) + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS events (
  event_id UUID,
  org_id UUID,
  workspace_id UUID,
  event_type LowCardinality(String),
  source_system LowCardinality(String),
  stream_offset Nullable(String),
  payload String,
  emitted_at DateTime64(3)
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(emitted_at)
ORDER BY (org_id, event_type, emitted_at)
TTL toDateTime(emitted_at) + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS api_key_events (
  api_key_id UUID,
  org_id UUID,
  ip_address IPv6,
  user_agent String,
  request_path String,
  response_code UInt16,
  created_at DateTime64(3)
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (org_id, api_key_id, created_at)
TTL toDateTime(created_at) + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS token_usage (
  execution_step_id UUID,
  org_id UUID,
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
ORDER BY (org_id, created_at, execution_step_id)
-- Token usage retained longer than raw logs: billing recomputation
-- and dispute investigation routinely reach beyond 90 days.
TTL toDateTime(created_at) + INTERVAL 365 DAY;

-- Agent runtime epic (spec §6, §9). Separate from Postgres
-- execution.tool_calls (the durable record); this is the analytics-side
-- mirror for high-volume agent fanouts.
CREATE TABLE IF NOT EXISTS tool_invocations (
  invocation_id UUID,
  org_id UUID,
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
ORDER BY (org_id, capability_name, created_at)
TTL toDateTime(created_at) + INTERVAL 180 DAY;

-- Typed agent model (docs/reference/agent-schema.ts §6). One row per
-- AgentLogEntry — the append-only, info+ baseline traceability record for a
-- run. DebugOptions raises verbosity (promoting debug-level entries into this
-- stream); it does not toggle logging. Definition id/version and org/workspace
-- are denormalized so logs are queryable in isolation without a join back to
-- the Postgres definition. entry_data carries the type-specific payload as a
-- JSON string (the SEAM left loosely typed in agent-schema.ts).
CREATE TABLE IF NOT EXISTS agent_logs (
  log_id String,
  run_id String,
  definition_id String,
  definition_version String,
  org_id String,
  workspace_id String,
  entry_id String,
  entry_type LowCardinality(String),
  entry_level LowCardinality(String),
  entry_message String,
  entry_data String,
  entry_timestamp DateTime64(3),
  created_at DateTime64(3) DEFAULT now64(3)
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(entry_timestamp)
ORDER BY (org_id, workspace_id, run_id, entry_timestamp)
-- Matches execution_logs' 90-day window: agent logs are raw run telemetry.
TTL toDateTime(entry_timestamp) + INTERVAL 90 DAY;

-- Skill lifecycle telemetry (OXA-1750). One row per skill load — emitted when a
-- workspace skill is loaded into an agent run (agent.skill.load) or surfaced
-- through any other entry point. Powers the skill.metrics.read handler: loads
-- per skill, loads per version, and last-used. org/workspace/skill are
-- denormalized so metrics query in isolation without a Postgres join.
-- skill_version is the integer skill version (UInt32); execution_step_id ties
-- the load to a run step when one is in scope (NULL for standalone loads).
CREATE TABLE IF NOT EXISTS skill_loads (
  org_id String,
  workspace_id String,
  skill_id String,
  skill_slug String,
  skill_version UInt32,
  execution_step_id Nullable(String),
  surface String,
  load_latency_ms Nullable(UInt32),
  created_at DateTime DEFAULT now()
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (org_id, workspace_id, skill_id, created_at);
