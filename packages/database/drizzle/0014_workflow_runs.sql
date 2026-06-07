-- 0014_workflow_runs.sql
--
-- Create the agent.workflow_runs + agent.workflow_run_tasks tables backing the
-- multi-agent workflow capability (workflow.run / workflow.status / workflow.cancel).
-- These tables are declared in packages/database/src/schema/workflow-runs.ts and
-- are referenced by 0016_workflow_run_rls_policies.sql; this migration is their
-- system of record. Mirrors the id/audit/org-scope mixins and matches the
-- table-creation style of 0008_installable_plugins.sql.
--
-- Forward migration — immutable after merge (OXA-1515 policy).

-- ── agent.workflow_runs ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent.workflow_runs (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext      NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  org_id             uuid        NOT NULL,
  workspace_id       uuid        NOT NULL,
  title              text        NOT NULL,
  goal               text        NOT NULL,
  status             citext      NOT NULL DEFAULT 'planning',
  plan_json          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  total_tasks        integer     NOT NULL DEFAULT 0,
  completed_tasks    integer     NOT NULL DEFAULT 0,
  failed_tasks       integer     NOT NULL DEFAULT 0,
  max_parallelism    integer     NOT NULL DEFAULT 50,
  output_format      citext      NOT NULL DEFAULT 'json',
  result_url         text,
  started_at         timestamptz,
  completed_at       timestamptz,
  CONSTRAINT workflow_runs_status_check
    CHECK (status IN ('planning', 'running', 'completed', 'failed', 'cancelled')),
  CONSTRAINT workflow_runs_output_format_check
    CHECK (output_format IN ('json', 'csv'))
);

CREATE INDEX IF NOT EXISTS workflow_runs_org_status_idx
  ON agent.workflow_runs (org_id, workspace_id, status);
CREATE INDEX IF NOT EXISTS workflow_runs_org_idx
  ON agent.workflow_runs (org_id, workspace_id);

-- ── agent.workflow_run_tasks ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent.workflow_run_tasks (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext      NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  org_id             uuid        NOT NULL,
  workspace_id       uuid        NOT NULL,
  workflow_run_id    uuid        NOT NULL,
  task_index         integer     NOT NULL,
  title              text        NOT NULL,
  goal               text        NOT NULL,
  status             citext      NOT NULL DEFAULT 'pending',
  inngest_run_id     text,
  output_json        jsonb,
  error              text,
  started_at         timestamptz,
  completed_at       timestamptz,
  CONSTRAINT workflow_run_tasks_status_check
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS workflow_run_tasks_run_idx
  ON agent.workflow_run_tasks (workflow_run_id);
CREATE INDEX IF NOT EXISTS workflow_run_tasks_org_status_idx
  ON agent.workflow_run_tasks (org_id, workspace_id, status);
CREATE INDEX IF NOT EXISTS workflow_run_tasks_org_idx
  ON agent.workflow_run_tasks (org_id, workspace_id);

-- ── Enable RLS (policies added in 0016) ──────────────────────────────────────
ALTER TABLE agent.workflow_runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.workflow_run_tasks ENABLE ROW LEVEL SECURITY;

-- ── oxagen_app grants ────────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent.workflow_runs      TO oxagen_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON agent.workflow_run_tasks TO oxagen_app;
  END IF;
END;
$$;
