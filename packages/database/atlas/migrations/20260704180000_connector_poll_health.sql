-- Connector poll/sync loop — health + scheduling columns on source_connections.
--
-- The generic poll loop (packages/inngest-functions ingestion.poll-scheduler +
-- ingestion.connection-poll) drives every active connection whose connector
-- implements poll(). Postgres is the operational source of truth for sync
-- health and scheduling (Connector Dual-Write law), so these columns live here:
--
--   health_status              healthy | degraded | errored — rolled-up poll
--                              outcome for the UI + self-healing scheduler.
--   consecutive_failure_count  drives exponential backoff and the health
--                              transition; reset to 0 on any successful poll.
--   last_poll_at               last poll attempt (success OR failure).
--   next_poll_at               when the connection is next due; the scheduler
--                              cron claims rows with next_poll_at <= now() (or
--                              null = never polled).
--   last_error_at             timestamp of the most recent poll failure.
--
-- A partial-free btree on next_poll_at backs the scheduler's due-work scan.
--
-- Hand-written + `atlas migrate hash` because `atlas migrate diff` is broken by
-- the pg_trgm fresh-replay defect
-- (docs/specs/graph-mediated-fanout/atlas-fresh-replay-defect.md).

ALTER TABLE ingestion.source_connections
  ADD COLUMN IF NOT EXISTS health_status text NOT NULL DEFAULT 'healthy',
  ADD COLUMN IF NOT EXISTS consecutive_failure_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_poll_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_poll_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_error_at timestamptz;

ALTER TABLE ingestion.source_connections
  DROP CONSTRAINT IF EXISTS source_connections_health_status_check;

ALTER TABLE ingestion.source_connections
  ADD CONSTRAINT source_connections_health_status_check
  CHECK (health_status IN ('healthy', 'degraded', 'errored'));

CREATE INDEX IF NOT EXISTS source_connections_next_poll_due_idx
  ON ingestion.source_connections (next_poll_at);
