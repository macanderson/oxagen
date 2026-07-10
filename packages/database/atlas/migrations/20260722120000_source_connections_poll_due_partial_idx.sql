-- Poll-scheduler due-work scan (packages/inngest-functions/src/functions/ingestion.poll-scheduler.ts):
--   WHERE status = 'connected' AND deleted_at IS NULL
--     AND connector_id = ANY($1) AND (next_poll_at IS NULL OR next_poll_at <= NOW())
--   ORDER BY next_poll_at ASC NULLS FIRST
-- The existing source_connections_next_poll_due_idx is a NON-partial btree on
-- (next_poll_at); it also scans deleted/paused/errored rows. This partial index
-- is confined to poll-eligible rows and still serves the ORDER BY. Additive,
-- idempotent. The old index is kept for paths that order by next_poll_at
-- irrespective of status.
CREATE INDEX IF NOT EXISTS "source_connections_poll_due_partial_idx"
  ON "ingestion"."source_connections" ("next_poll_at")
  WHERE status = 'connected' AND deleted_at IS NULL;
