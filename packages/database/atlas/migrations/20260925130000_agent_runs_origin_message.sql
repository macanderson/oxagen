-- The chat message that asked for a run (#4167).
--
-- An in-app assistant turn is a ledger run, and it meters every model call on
-- the person's message id: the message exists before the run is admitted, and
-- the turn's recall, approvals and credit debits all name it. The cost rollup
-- reads a ledger run's model calls from `token_usage` by the run's own uuid,
-- so it found none of a turn's calls and priced nothing. The run now names
-- its message, and the rollup reads the calls by either id.
--
-- Nullable and without a default: every run admitted before this, and every
-- run that is not an assistant turn, names no message. Adding a nullable
-- column without a default rewrites nothing and takes no long lock.
ALTER TABLE "agent"."agent_runs"
  ADD COLUMN "origin_message_id" uuid NULL;
