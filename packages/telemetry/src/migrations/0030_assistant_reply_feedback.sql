-- 0030_assistant_reply_feedback.sql
--
-- A person's verdict on one reply of the in-app assistant (#4169). One row per
-- vote: the run the reply was recorded as, the conversation and message that
-- hold the reply, the person who voted, the verdict, and an optional short
-- note. `record_reply_feedback` writes it after checking that the run is an
-- assistant run in the workspace and that the reply sits in the voter's own
-- conversation.
--
-- Append-only, like every table in this store. A vote is never updated and
-- never deleted. A person who changes their mind votes again, which writes a
-- second row, and a reader takes the newest row per (user_id, run_public_id)
-- with argMax(..., created_at). readReplyFeedback in reply-feedback.ts is that
-- reader, and it is how the replay set picks the turns people marked wrong.
--
-- Tenant-scoped: written through chInsert, which stamps org_id and
-- workspace_id from the active scope, and read through chSelect, which
-- filters on both. ORDER BY leads with (org_id, workspace_id, run_public_id)
-- because every read names one workspace and a run or a window of runs.
--
-- Retained 365 days, the window token_usage and router_outcomes keep. A
-- verdict labels a turn for review and replay. The run it points at is kept
-- by the evidence ledger on its own retention, so dropping an old vote loses
-- a label and never a record.
CREATE TABLE IF NOT EXISTS assistant_reply_feedback (
  org_id UUID,
  workspace_id UUID,

  -- `arun_...`: the run the reply was recorded as (agent.agent_runs.public_id).
  -- String, not UUID: it is the public id the Run page and get_run take.
  run_public_id String,
  -- chat.conversations.id and chat.messages.id of the reply.
  conversation_id UUID,
  message_id UUID,
  -- The person who voted (auth.users.id). An API key votes as its creator.
  user_id UUID,

  -- 'useful' or 'wrong'. The contract admits no other value.
  verdict LowCardinality(String),
  -- The person's reason, at most 500 characters (the contract's cap). Empty
  -- when they gave none.
  note String DEFAULT '' CODEC(ZSTD(3)),

  created_at DateTime64(3) DEFAULT now64(3) CODEC(DoubleDelta, ZSTD(1))
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(created_at)
ORDER BY (org_id, workspace_id, run_public_id, user_id, created_at)
TTL toDateTime(created_at) + INTERVAL 365 DAY;
