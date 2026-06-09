-- 0030_ensure_content_workflow_schemas.sql
--
-- Forward migration — idempotent guard for content and workflow schemas.
--
-- 0028 created content.documents/forms and workflow.automations/automation_runs,
-- assuming the baseline's schema creation had already run. On DBs predating the
-- baseline's workflow-schema creation (where workflow tables historically lived
-- in the agent schema), 0028 failed with 'schema workflow does not exist'.
--
-- This migration adds idempotent CREATE SCHEMA IF NOT EXISTS so the tables are
-- self-sufficient on any DB state — forward migrations that depend on them no
-- longer need to be edited to re-introduce schema creation.
--
BEGIN;

CREATE SCHEMA IF NOT EXISTS content;
CREATE SCHEMA IF NOT EXISTS workflow;

COMMIT;
