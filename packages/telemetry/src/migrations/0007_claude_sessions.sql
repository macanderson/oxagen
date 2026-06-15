-- 0007_claude_sessions.sql
--
-- Replace internal.agent_executions with internal.claude_sessions.
-- The new table captures the full per-message JSONL payload including
-- separately-tracked cache tier tokens (for correct cost calculation),
-- tool call arrays, thinking token counts, git branch, and subagent flag.
--
-- Cost is computed at insert time using published Anthropic rates.
-- 1h ephemeral cache writes are charged at 2x the standard cache write rate.

DROP TABLE IF EXISTS agent_executions;

CREATE TABLE IF NOT EXISTS claude_sessions (
  -- When the assistant response was generated
  timestamp       DateTime64(3),

  -- Dedup key: JSONL entry uuid (always present on assistant entries)
  entry_uuid      UUID,

  -- Conversation grouping
  session_id      UUID,

  -- Anthropic API message ID (msg_01...; empty on synthetic/error messages)
  message_id      String DEFAULT '',

  -- req_... for cross-system tracing
  request_id      String DEFAULT '',

  -- UUID of the parent message in the conversation tree
  parent_uuid     UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),

  -- Who / where
  user_email      LowCardinality(String),
  model           LowCardinality(String),
  version         String DEFAULT '',
  entrypoint      LowCardinality(String) DEFAULT 'cli',
  git_branch      String DEFAULT '',
  cwd             String DEFAULT '',

  -- 1 if this row came from a subagents/ subdirectory
  is_subagent     UInt8 DEFAULT 0,
  is_sidechain    UInt8 DEFAULT 0,

  -- Response shape
  stop_reason     LowCardinality(String) DEFAULT '',
  service_tier    LowCardinality(String) DEFAULT 'standard',
  inference_geo   LowCardinality(String) DEFAULT '',
  speed           LowCardinality(String) DEFAULT 'standard',
  status          LowCardinality(String) DEFAULT 'success',
  error_type      String DEFAULT '',

  -- Token counts (UInt32 matches Anthropic's per-call maximums)
  tokens_in       UInt32 DEFAULT 0,   -- uncached input, billed at full rate
  tokens_out      UInt32 DEFAULT 0,
  cache_write_5m  UInt32 DEFAULT 0,   -- ephemeral_5m_input_tokens (standard write rate)
  cache_write_1h  UInt32 DEFAULT 0,   -- ephemeral_1h_input_tokens (2x write rate)
  cache_read      UInt32 DEFAULT 0,   -- cache_read_input_tokens

  -- Server-tool usage (billed separately by Anthropic)
  web_searches    UInt16 DEFAULT 0,
  web_fetches     UInt16 DEFAULT 0,

  -- Approximate reasoning token count (char count of thinking blocks / 4)
  thinking_tokens UInt32 DEFAULT 0,

  -- Estimated cost in USD microdollars (divide by 1,000,000 to get USD)
  cost_usd_micros UInt64 DEFAULT 0,

  -- Content
  session_prompt  String DEFAULT '',  -- first user message in this session, ≤1000 chars
  assistant_text  String DEFAULT '',  -- first 500 chars of the assistant text response
  tool_calls      Array(String),      -- tool names invoked in this response

  -- Duration from the session's first user message to this assistant response
  duration_ms     UInt32 DEFAULT 0,

  -- ReplacingMergeTree dedup version column
  inserted_at     DateTime64(3) DEFAULT now()

) ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY toYYYYMM(timestamp)
ORDER BY (user_email, session_id, timestamp, entry_uuid)
TTL toDateTime(timestamp) + INTERVAL 2 YEAR;
