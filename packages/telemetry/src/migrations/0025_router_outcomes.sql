-- 0025_router_outcomes.sql
--
-- Append-only observed outcomes of the Verified-Outcome Market Router. One row
-- per executed (revise) round: the task class it was routed for, the model/tier
-- that served it, whether the outcome was VERIFIED (tests passed / judge
-- complete / eval passed), the observed provider cost + latency, and the routing
-- mode in force. ClickHouse is the correct store — this is a high-volume,
-- append-only runtime-event stream (four-store data model in CLAUDE.md), the
-- source the router reads back to compute each task class's live cost/accuracy
-- Pareto curve (readRoutingStats).
--
-- Tenant-scoped (org_id/workspace_id) so it is written via chInsert (stamps
-- scope) and read via chSelect (fail-closed org_id filter) — one workspace can
-- never read another's routing history. Modeled after token_usage
-- (cost_usd_micros, LowCardinality model/surface, 365-day TTL) and
-- eval_item_results (tenant columns, Float32 score, verified UInt8).
--
-- Engine: MergeTree (pure append-only; a round writes exactly one row). ORDER BY
-- leads with (org_id, task_class, model, created_at) because the hot read groups
-- by (task_class, model) over a time window for one org — the exact prefix.
CREATE TABLE IF NOT EXISTS router_outcomes (
  org_id UUID,
  workspace_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),

  -- The turn/execution the outcome belongs to (trace id). String, not UUID: the
  -- engine's trace id is not always a canonical UUID, and a bad UUID parse would
  -- abort the whole row insert (see token_usage.execution_step_id note).
  execution_id String DEFAULT '',

  -- Stable low-cardinality task class from deriveTaskClass (e.g. "auth/single").
  task_class LowCardinality(String) DEFAULT '',
  -- SHA-256 (hex) of the refined prompt — dedup / drift signal, PII-free.
  signature_hash String DEFAULT '',

  -- The model that actually served the round, and the tier it counted as.
  model LowCardinality(String) DEFAULT '',
  tier LowCardinality(String) DEFAULT '',

  -- 1 when the outcome was a VERIFIED success, else 0. avg(verified) is the
  -- verified-success rate the router thresholds against.
  verified UInt8 DEFAULT 0,
  -- What proved it: 'tests' (executed tests passed) | 'judge' (completeness
  -- judge complete + confident) | 'eval' (eval pass) | 'completion' (turn
  -- finished, no stronger signal). Tests win when present.
  verification_source LowCardinality(String) DEFAULT '',
  -- Confidence / eval score in [0,1] (judge confidence/100 or eval score). Float32
  -- is ample precision for an aggregated rate and halves the column footprint.
  score Float32 DEFAULT 0,

  -- Observed provider cost for the round, in micro-USD (1 USD = 1e6) — same unit
  -- and codec as token_usage.cost_usd_micros so the two pipes stay comparable.
  cost_usd_micros UInt64 CODEC(T64, ZSTD(1)),
  -- Observed wall-clock latency of the round, in ms.
  latency_ms UInt32 DEFAULT 0,

  -- Which surface drove the turn: 'app' | 'cli' | 'api' | 'mcp' | ''.
  surface LowCardinality(String) DEFAULT '',
  -- Routing mode in force: 'static' (deterministic — today's routing, incl. the
  -- OFF policy), 'shadow' (decision computed, today's routing used), 'enforce'
  -- (market decision used). LowCardinality — tiny fixed set.
  routing_mode LowCardinality(String) DEFAULT 'static',

  created_at DateTime64(3) DEFAULT now64(3) CODEC(DoubleDelta, ZSTD(1)),

  -- Secondary filters not led by the sort key: model for per-model rollups when a
  -- query does not pin task_class, and execution_id for per-turn drill-down.
  INDEX idx_router_model model TYPE set(0) GRANULARITY 4,
  INDEX idx_router_execution execution_id TYPE bloom_filter(0.01) GRANULARITY 4
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (org_id, task_class, model, created_at)
-- Retained 365 days like token_usage: the router's Pareto read reaches back over
-- long windows, and outcome history is billing-adjacent investigation data.
TTL toDateTime(created_at) + INTERVAL 365 DAY;
