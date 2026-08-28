-- 0005_session_telemetry.sql
--
-- Session-scoped observability.
-- - token_usage: add conversation_id (session linkage) + cache_misses
-- - session_recaps: new table for aggregated telemetry + LLM-powered recap
--   (dropped in 0010_drop_dead_tables.sql — it had no readers or writers)

ALTER TABLE token_usage
  ADD COLUMN IF NOT EXISTS conversation_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),
  ADD COLUMN IF NOT EXISTS cache_misses UInt64 DEFAULT 0;

-- Session-level telemetry rollup. One row per conversation, refreshed async.
-- Spec §7: append-only with 365-day TTL (same as token_usage billing retention).
CREATE TABLE IF NOT EXISTS session_recaps (
  conversation_id UUID,
  org_id UUID,
  workspace_id UUID,
  -- Aggregated token counts from all token_usage rows in this conversation.
  total_input_tokens UInt64 DEFAULT 0,
  total_output_tokens UInt64 DEFAULT 0,
  total_cached_tokens UInt64 DEFAULT 0,
  total_cache_misses UInt64 DEFAULT 0,
  -- JSON breakdown: {provider: count_of_calls, ...}
  provider_breakdown String DEFAULT '{}',
  -- JSON breakdown: {model: count_of_calls, ...}
  model_breakdown String DEFAULT '{}',
  -- LLM-powered recap of the entire session. Plain text, ~100-200 words.
  -- Generated async by recap.generate Inngest function.
  recap String DEFAULT '',
  -- When the recap was generated (set by Inngest, NULL until first recap).
  recap_generated_at Nullable(DateTime64(3)),
  -- When this row was inserted/updated in ClickHouse.
  created_at DateTime64(3),
  updated_at DateTime64(3)
) ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(created_at)
ORDER BY (org_id, conversation_id, created_at)
TTL toDateTime(created_at) + INTERVAL 365 DAY;
