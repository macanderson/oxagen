-- Fix stale CHECK constraints that made source-connection deletion fail (OXA-1751).
--
-- connection.delete sets source_connections.status='deleting' synchronously and
-- the async purge job (ingestion.delete) sets the terminal 'deleted'; both were
-- rejected by the old status CHECK, so every delete violated the constraint and
-- surfaced as a 500 "Unexpected server error" before any work happened.
--
-- The deletion_jobs.delete_mode CHECK still allowed only the legacy 'soft'/'hard'
-- values instead of the contract modes connection_only | data_only | full, so the
-- tracking-row insert in connection.delete also violated its CHECK.
--
-- Modify "source_connections" table
ALTER TABLE "ingestion"."source_connections" DROP CONSTRAINT "source_connections_status_check", ADD CONSTRAINT "source_connections_status_check" CHECK (status = ANY (ARRAY['pending_setup'::text, 'connected'::text, 'paused'::text, 'error'::text, 'deleting'::text, 'deleted'::text]));
-- Modify "deletion_jobs" table
ALTER TABLE "ingestion"."deletion_jobs" DROP CONSTRAINT "deletion_jobs_delete_mode_check", ADD CONSTRAINT "deletion_jobs_delete_mode_check" CHECK (delete_mode = ANY (ARRAY['connection_only'::text, 'data_only'::text, 'full'::text]));
