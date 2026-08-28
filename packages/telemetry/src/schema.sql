-- Migration 0000 / baseline. This file is re-applied idempotently on every
-- migrate() run (all statements use CREATE TABLE IF NOT EXISTS). Numbered
-- migrations in migrations/ start at 0002 because 0001 was folded into this
-- baseline before versioned tracking began. Add new columns or tables via a
-- new numbered migration file; do not edit this baseline.
--
-- Append-only telemetry. Monthly partitions, 90-day TTL on raw
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
  -- Prompt-cache READ tokens (cache hits), billed by the provider at ~0.1x base
  -- input. A subset of input_tokens, not additive — the @oxagen/ai gateway
  -- normalizes input_tokens to the inclusive total (fresh + cache reads + cache
  -- writes), so fresh = input_tokens - cached_tokens - cache_write_tokens.
  cached_tokens UInt64 CODEC(T64, ZSTD(1)),
  -- Prompt-cache WRITE tokens (cache creation), billed by the provider at ~1.25x
  -- base input (5-min TTL). Also a subset of input_tokens (see cached_tokens).
  -- Migration 0026: pre-0026 rows default to 0 (their true split is unknowable),
  -- which the cost formula treats as "no cache writes" — a safe lower bound.
  cache_write_tokens UInt64 CODEC(T64, ZSTD(1)),
  cost_usd_micros UInt64 CODEC(T64, ZSTD(1)),
  duration_ms UInt32 DEFAULT 0,
  surface LowCardinality(String) DEFAULT '',
  prompt_hash String DEFAULT '',
  -- Principal attribution (migration 0023): who drove the spend. Stamped
  -- from the ambient tenant scope at the insert boundary; nil UUID / ''
  -- sentinels mean "not resolved" (non-enterprise IAM fast-path, or a write
  -- outside any capability invocation).
  principal_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  principal_kind LowCardinality(String) DEFAULT '',
  user_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  capability_name LowCardinality(String) DEFAULT '',
  created_at DateTime64(3) CODEC(DoubleDelta, ZSTD(1)),
  -- model is LowCardinality and not in the ORDER BY key; a set skip index
  -- prunes granules for per-model cost/usage rollups (migration 0009).
  INDEX idx_token_model model TYPE set(0) GRANULARITY 4,
  INDEX idx_token_capability capability_name TYPE set(0) GRANULARITY 4,
  INDEX idx_token_principal principal_id TYPE bloom_filter(0.01) GRANULARITY 4
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (org_id, created_at, execution_step_id)
-- Token usage retained longer than raw logs: billing recomputation
-- and dispute investigation routinely reach beyond 90 days.
TTL toDateTime(created_at) + INTERVAL 365 DAY;

-- Agent runtime (docs/specs/agent-runtime/spec.md §6, §9). Separate from
-- Postgres execution.tool_calls (the durable record); this is the
-- analytics-side mirror for high-volume agent fanouts.
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
  -- Principal attribution (migration 0023) — see token_usage above.
  principal_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  principal_kind LowCardinality(String) DEFAULT '',
  user_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  created_at DateTime64(3) CODEC(DoubleDelta, ZSTD(1)),
  -- Secondary filters not led by the key (capability_name leads): status for
  -- failed-call dashboards, message_id for per-message trace expansion (0009).
  INDEX idx_tool_status status TYPE set(0) GRANULARITY 4,
  INDEX idx_tool_message_id message_id TYPE bloom_filter(0.01) GRANULARITY 4,
  INDEX idx_tool_principal principal_id TYPE bloom_filter(0.01) GRANULARITY 4
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (org_id, capability_name, created_at)
TTL toDateTime(created_at) + INTERVAL 180 DAY;

-- Skill lifecycle telemetry. One row per skill load — emitted when a
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

-- ---------------------------------------------------------------------------
-- Eval results (agent-eval protocol). Two append-only tables that record every
-- run of an agent-eval harness (engram-golden, terminal-bench, rag-eval,
-- context-eval, swe-bench, …) so we can (a) measure the code agent improving
-- over TIME — versions, warm rounds, accumulated graph/memory depth — and
-- (b) detect behavioral REGRESSION per task. Design notes:
--   * Flexible "protocol" shape: a small set of typed core dimensions every
--     harness shares, plus open Map(String,Float64) `metrics` and
--     Map(String,String) `labels` so a NEW metric needs no migration.
--   * Denormalized slice dims (harness/suite/agent_version/model/cell flags) on
--     BOTH tables so each queries standalone (ClickHouse-idiomatic, no joins).
--   * NOT tenant-scoped: these measure the product itself (CI/local/research),
--     so there is no org_id key — unlike the request-telemetry tables above.
--   * run_id / task_id are String, never UUID: benchmark task ids are
--     non-UUID (e.g. 'gpt2-codegolf__saXZwmX'); writing a non-UUID string into a
--     UUID column aborts the whole row.

-- One row per RUN (suite-level header + rollup). ReplacingMergeTree(updated_at)
-- so the run can be written once at start and re-inserted finalized at end
-- (later updated_at wins) — query with FINAL. Kept forever (no TTL): this IS the
-- time series we measure improvement against, and runs are low-volume.
CREATE TABLE IF NOT EXISTS eval_runs (
  run_id String,
  run_group LowCardinality(String) DEFAULT '',
  schema_version UInt16 DEFAULT 1,
  agent_name LowCardinality(String),
  agent_version LowCardinality(String),
  model LowCardinality(String),
  harness LowCardinality(String),
  suite LowCardinality(String),
  suite_version LowCardinality(String) DEFAULT '',
  git_sha String DEFAULT '',
  git_branch LowCardinality(String) DEFAULT '',
  environment LowCardinality(String) DEFAULT '',
  config_hash String DEFAULT '',
  -- ablation cell (2^3 factorial: graph_code x graph_exec x graph_mem) + self-improvement axes
  graph_code UInt8 DEFAULT 0,
  graph_exec UInt8 DEFAULT 0,
  graph_mem UInt8 DEFAULT 0,
  warm UInt8 DEFAULT 0,
  history_depth UInt32 DEFAULT 0,
  seed Int64 DEFAULT 0,
  -- suite-level outcomes
  n_tasks UInt32 DEFAULT 0,
  n_passed UInt32 DEFAULT 0,
  resolved_rate Float64 DEFAULT 0,
  metrics Map(LowCardinality(String), Float64),
  labels Map(LowCardinality(String), String),
  notes String DEFAULT '',
  started_at DateTime64(3) DEFAULT now64(3),
  finished_at DateTime64(3) DEFAULT now64(3),
  updated_at DateTime64(3) DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(started_at)
ORDER BY (harness, suite, agent_name, agent_version, run_id);

-- One row per (run, task[, repeat]) — the per-task detail for regression hunting.
-- Append-only; 365-day TTL (detail is higher-volume and regenerable; the run
-- rollup in eval_runs preserves the long-term improvement signal).
CREATE TABLE IF NOT EXISTS eval_results (
  run_id String,
  task_id String,
  task_group LowCardinality(String) DEFAULT '',
  repeat_idx UInt16 DEFAULT 0,
  harness LowCardinality(String),
  suite LowCardinality(String),
  agent_name LowCardinality(String),
  agent_version LowCardinality(String),
  model LowCardinality(String),
  graph_code UInt8 DEFAULT 0,
  graph_exec UInt8 DEFAULT 0,
  graph_mem UInt8 DEFAULT 0,
  warm UInt8 DEFAULT 0,
  history_depth UInt32 DEFAULT 0,
  passed UInt8 DEFAULT 0,
  reward Float64 DEFAULT 0,
  metrics Map(LowCardinality(String), Float64),
  labels Map(LowCardinality(String), String),
  started_at DateTime64(3) DEFAULT now64(3),
  created_at DateTime DEFAULT now() CODEC(DoubleDelta, ZSTD(1))
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (harness, suite, task_id, agent_version, created_at)
TTL toDateTime(created_at) + INTERVAL 365 DAY;

-- Per-item results for customer-facing Evals v1 (eval.run.start). DISTINCT from
-- the private bench-harness eval_runs/eval_results above (those have no tenant
-- columns): this is tenant-scoped (org_id/workspace_id), written via chInsert
-- and read via chSelect so customer eval detail stays isolated per workspace.
-- Run-level summary lives in Postgres eval.eval_runs; this is the drill-down.
CREATE TABLE IF NOT EXISTS eval_item_results (
  org_id UUID,
  workspace_id UUID,
  run_id String,
  dataset_id String,
  item_id String,
  target_kind LowCardinality(String) DEFAULT '',
  model LowCardinality(String) DEFAULT '',
  judge_model LowCardinality(String) DEFAULT '',
  score Float64 DEFAULT 0,
  correctness Float64 DEFAULT 0,
  faithfulness Float64 DEFAULT 0,
  passed UInt8 DEFAULT 0,
  latency_ms UInt32 DEFAULT 0,
  input_tokens UInt32 DEFAULT 0,
  output_tokens UInt32 DEFAULT 0,
  cost_usd_micros Int64 DEFAULT 0,
  status LowCardinality(String) DEFAULT 'completed',
  error_class LowCardinality(String) DEFAULT '',
  output String CODEC(ZSTD(3)),
  rationale String CODEC(ZSTD(3)),
  created_at DateTime DEFAULT now() CODEC(DoubleDelta, ZSTD(1))
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (org_id, workspace_id, run_id, item_id, created_at)
TTL toDateTime(created_at) + INTERVAL 365 DAY;

-- Local dev console capture. `pnpm dev` tees turbo's combined output stream to
-- the terminal AND batch-inserts every line here (see tools/scripts/dev.ts +
-- lib/dev-log-shipper.ts), so the compile/runtime errors that used to scroll
-- past in the terminal become queryable. Local-only telemetry: short 14-day TTL,
-- keyed by dev_session so one `pnpm dev` run is one queryable stream.
CREATE TABLE IF NOT EXISTS dev_logs (
  ts DateTime64(3) DEFAULT now64(3) CODEC(DoubleDelta, ZSTD(1)),
  dev_session String,
  service LowCardinality(String),
  stream LowCardinality(String),
  level LowCardinality(String),
  message String CODEC(ZSTD(3)),
  host LowCardinality(String) DEFAULT ''
) ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(ts)
ORDER BY (dev_session, service, ts)
TTL toDateTime(ts) + INTERVAL 14 DAY;

-- Durable-sandbox command output (docs/specs/sandbox-session-lifecycle/spec.md §5.2). One row
-- per line of a coding-session command's stdout/stderr, plus a 'system'/'debug'
-- line per command (the command echo + exit code + duration). Powers the sandbox
-- inspector's log console; the debug toggle filters on `level`. Tenant-scoped;
-- 14-day TTL. Keyed by the opaque session public id (sbx_…).
CREATE TABLE IF NOT EXISTS sandbox_log_events (
  ts DateTime64(3) DEFAULT now64(3) CODEC(DoubleDelta, ZSTD(1)),
  org_id UUID,
  workspace_id UUID,
  session_id String,
  stream LowCardinality(String),
  level LowCardinality(String),
  command String CODEC(ZSTD(3)),
  seq UInt32,
  line String CODEC(ZSTD(3)),
  exit_code Nullable(Int32),
  duration_ms Nullable(UInt32)
) ENGINE = MergeTree()
PARTITION BY toYYYYMMDD(ts)
ORDER BY (org_id, workspace_id, session_id, ts)
TTL toDateTime(ts) + INTERVAL 14 DAY;

-- Verified-Outcome Market Router observed outcomes (migration 0025). One
-- append-only row per executed (revise) round: the task class it was routed for,
-- the model/tier that served it, whether the outcome was VERIFIED, observed cost
-- + latency, and the routing mode. The router reads this back (readRoutingStats)
-- to compute each task class's live cost/accuracy Pareto curve. Tenant-scoped
-- (chInsert/chSelect); 365-day TTL like token_usage. See the migration file for
-- the full column rationale.
CREATE TABLE IF NOT EXISTS router_outcomes (
  org_id UUID,
  workspace_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  execution_id String DEFAULT '',
  task_class LowCardinality(String) DEFAULT '',
  signature_hash String DEFAULT '',
  model LowCardinality(String) DEFAULT '',
  tier LowCardinality(String) DEFAULT '',
  verified UInt8 DEFAULT 0,
  verification_source LowCardinality(String) DEFAULT '',
  score Float32 DEFAULT 0,
  cost_usd_micros UInt64 CODEC(T64, ZSTD(1)),
  latency_ms UInt32 DEFAULT 0,
  surface LowCardinality(String) DEFAULT '',
  routing_mode LowCardinality(String) DEFAULT 'static',
  created_at DateTime64(3) DEFAULT now64(3) CODEC(DoubleDelta, ZSTD(1)),
  INDEX idx_router_model model TYPE set(0) GRANULARITY 4,
  INDEX idx_router_execution execution_id TYPE bloom_filter(0.01) GRANULARITY 4
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (org_id, task_class, model, created_at)
TTL toDateTime(created_at) + INTERVAL 365 DAY;
