-- 0006_claude_telemetry.sql
--
-- Claude Code session telemetry table for tracking IDE interactions and token usage
-- across all Claude Code sessions. Enables observability of development time
-- spent and model usage patterns.
--
-- Source: ~/.claude/projects/*/[sessionId].jsonl (historical backfill + realtime hook)
-- Inserted by: apps/api /api/v1/telemetry/claude (realtime) or backfill script (historical)

CREATE TABLE IF NOT EXISTS agent_executions (
  -- Execution timestamp (when the assistant response was generated)
  timestamp DateTime DEFAULT now(),

  -- Event type (always 'claude-code' for IDE sessions)
  type String,

  -- User email running Claude Code
  user_email String,

  -- Claude Code session ID (UUID)
  session_id UUID,

  -- Model used (e.g. 'claude-opus-4-8', 'claude-sonnet-4-6')
  model String,

  -- First user message or assistant response text (first 500 chars)
  prompt String,

  -- Input tokens from Anthropic usage object
  tokens_in UInt32,

  -- Output tokens from Anthropic usage object
  tokens_out UInt32,

  -- Cache read tokens (cache_read_input_tokens) — reused cached prompt bytes
  cache_tokens_read UInt32 DEFAULT 0,

  -- Cache creation tokens (cache_creation_input_tokens) — new cache writes
  cache_tokens_created UInt32 DEFAULT 0,

  -- Files modified in this session (extracted from cwd + git diff)
  -- Populated by backfill if available; empty array otherwise
  files_modified Array(String),

  -- Wall-clock duration from first user msg to assistant response (ms)
  duration_ms UInt32,

  -- Status of the invocation ('success', 'error', etc.)
  status String DEFAULT 'success',

  -- Conversation ID linking to broader chat context (optional; defaults to zero UUID)
  conversation_id UUID DEFAULT toUUID('00000000-0000-0000-0000-000000000000'),

  -- AI provider ('anthropic', 'openai', etc.)
  provider LowCardinality(String) DEFAULT 'anthropic',

  -- Cached tokens (synonym for cache_tokens_read in some contexts)
  cached_tokens UInt64 DEFAULT 0,

  -- Cache miss count
  cache_misses UInt64 DEFAULT 0,

  -- Estimated cost in USD microdollars (1/1,000,000 of USD)
  cost_usd_micros UInt64 DEFAULT 0,

  -- Invocation surface ('claude-code', 'web', 'api', etc.)
  surface LowCardinality(String) DEFAULT 'claude-code',

  -- Hash of the prompt (for dedup / similarity searches)
  prompt_hash String DEFAULT '',

  -- LLM-powered summary of the entire session
  session_recap String DEFAULT '',

  -- When the recap was generated
  recap_generated_at Nullable(DateTime64(3)),

  -- When this row was inserted/updated
  updated_at DateTime64(3) DEFAULT now(),

  -- Extended metadata (stored as JSON for forward compatibility)
  -- {entrypoint: "cli"|"web", version: "2.1.158", gitBranch: "main",
  --  requestId: "req_...", inferenceGeo: "not_available",
  --  serviceTier: "standard", thinkingEnabled: bool, reasoningTokens: int}
  metadata String DEFAULT '{}'
) ENGINE = ReplacingMergeTree(updated_at)
PARTITION BY toYYYYMM(timestamp)
ORDER BY (user_email, session_id, timestamp)
TTL toDateTime(timestamp) + INTERVAL 1 YEAR;
