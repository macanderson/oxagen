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
  message String CODEC(ZSTD(3)),
  metadata String CODEC(ZSTD(3)),
  created_at DateTime64(3) CODEC(DoubleDelta, ZSTD(1))
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (org_id, execution_id, created_at)
TTL toDateTime(created_at) + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS events (
  event_id UUID,
  org_id UUID,
  workspace_id UUID,
  event_type LowCardinality(String),
  source_system LowCardinality(String),
  stream_offset Nullable(String),
  payload String CODEC(ZSTD(3)),
  emitted_at DateTime64(3) CODEC(DoubleDelta, ZSTD(1))
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(emitted_at)
ORDER BY (org_id, event_type, emitted_at)
TTL toDateTime(emitted_at) + INTERVAL 90 DAY;

CREATE TABLE IF NOT EXISTS token_usage (
  -- Non-nullable UUID AND part of the sorting key below, so it CANNOT be made
  -- Nullable after creation (ALTER_OF_COLUMN_IS_FORBIDDEN, code 524 — even with
  -- allow_nullable_key=1; would need a full table rebuild). "No execution step"
  -- is therefore the nil UUID ('0…0'), coalesced from null at the insert
  -- boundary in @oxagen/telemetry (insertTokenUsage / NIL_UUID). NEVER write a
  -- non-UUID correlation string here — it aborts the whole row insert with
  -- CANNOT_PARSE_INPUT_ASSERTION_FAILED. See migration 0012.
  execution_step_id UUID,
  org_id UUID,
  workspace_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  model LowCardinality(String),
  provider LowCardinality(String) DEFAULT '',
  input_tokens UInt64 CODEC(T64, ZSTD(1)),
  output_tokens UInt64 CODEC(T64, ZSTD(1)),
  cached_tokens UInt64 CODEC(T64, ZSTD(1)),
  cost_usd_micros UInt64 CODEC(T64, ZSTD(1)),
  duration_ms UInt32 DEFAULT 0,
  surface LowCardinality(String) DEFAULT '',
  prompt_hash String DEFAULT '',
  created_at DateTime64(3) CODEC(DoubleDelta, ZSTD(1)),
  -- model is LowCardinality and not in the ORDER BY key; a set skip index
  -- prunes granules for per-model cost/usage rollups (migration 0009).
  INDEX idx_token_model model TYPE set(0) GRANULARITY 4
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
  created_at DateTime64(3) CODEC(DoubleDelta, ZSTD(1)),
  -- Secondary filters not led by the key (capability_name leads): status for
  -- failed-call dashboards, message_id for per-message trace expansion (0009).
  INDEX idx_tool_status status TYPE set(0) GRANULARITY 4,
  INDEX idx_tool_message_id message_id TYPE bloom_filter(0.01) GRANULARITY 4
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (org_id, capability_name, created_at)
TTL toDateTime(created_at) + INTERVAL 180 DAY;

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
  surface LowCardinality(String),
  load_latency_ms Nullable(UInt32),
  created_at DateTime DEFAULT now() CODEC(DoubleDelta, ZSTD(1))
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (org_id, workspace_id, skill_id, created_at)
-- Skill-load metrics keep billing-grade (365-day) retention rather than the
-- 90-day raw-log window: readSkillMetrics' last_used reaches back arbitrarily,
-- and aggregate load counts have long-tail value (migration 0009). created_at
-- is plain DateTime, so no toDateTime() cast is needed.
TTL created_at + INTERVAL 365 DAY;
