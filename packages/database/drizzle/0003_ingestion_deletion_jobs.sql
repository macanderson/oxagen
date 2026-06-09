-- 0003_ingestion_deletion_jobs.sql
-- Async deletion job tracking for data-source connection removal.
-- Supports three modes:
--   connection_only — revoke auth + stop ingestion, keep Neo4j entity data
--   data_only       — delete Neo4j entity data, keep connection (used by re-ingest)
--   full            — delete everything: auth + Neo4j data + mapping config
-- The Inngest function updates deleted_entities and alias_promotions as it runs
-- so the UI can show real-time progress.

CREATE TABLE ingestion.deletion_jobs (
  id                  UUID        NOT NULL DEFAULT COALESCE(
                                    CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                                      THEN uuid_generate_v7()
                                      ELSE uuid_generate_v4()
                                    END,
                                    uuid_generate_v4()
                                  ),
  public_id           CITEXT      NOT NULL UNIQUE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Not a FK — the source_connection row may itself be deleted by this job.
  connection_id       UUID        NOT NULL,
  workspace_id        UUID        NOT NULL,
  org_id              UUID        NOT NULL,
  -- connection_only | data_only | full
  delete_mode         TEXT        NOT NULL,
  requested_by        UUID        NOT NULL,
  -- Set after the Inngest count step; null until counting completes.
  total_entities      INTEGER,
  deleted_entities    INTEGER     NOT NULL DEFAULT 0,
  -- Alias promotions: how many Case C (cross-connection principal) promotions ran.
  alias_promotions    INTEGER     NOT NULL DEFAULT 0,
  -- running | completed | failed
  status              TEXT        NOT NULL DEFAULT 'running',
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ,
  error               TEXT,
  PRIMARY KEY (id),
  CONSTRAINT deletion_jobs_delete_mode_chk
    CHECK (delete_mode IN ('connection_only','data_only','full')),
  CONSTRAINT deletion_jobs_status_chk
    CHECK (status IN ('running','completed','failed'))
);

CREATE INDEX deletion_jobs_connection_idx ON ingestion.deletion_jobs (connection_id);
CREATE INDEX deletion_jobs_workspace_idx  ON ingestion.deletion_jobs (workspace_id);
CREATE INDEX deletion_jobs_status_idx     ON ingestion.deletion_jobs (status) WHERE status = 'running';
