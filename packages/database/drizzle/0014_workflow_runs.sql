-- 0014_workflow_runs.sql — workflow supervisor tables.
-- agent.workflow_runs: tracks a multi-task parallel workflow dispatch.
-- agent.workflow_run_tasks: one row per planned sub-task.
-- Forward migration (immutable after merge).

CREATE TABLE agent.workflow_runs (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  org_id             uuid NOT NULL,
  workspace_id       uuid NOT NULL,
  title              text NOT NULL,
  goal               text NOT NULL,
  status             citext NOT NULL DEFAULT 'planning',
  plan_json          jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_tasks        integer NOT NULL DEFAULT 0,
  completed_tasks    integer NOT NULL DEFAULT 0,
  failed_tasks       integer NOT NULL DEFAULT 0,
  max_parallelism    integer NOT NULL DEFAULT 50,
  output_format      citext NOT NULL DEFAULT 'json',
  result_url         text,
  started_at         timestamptz,
  completed_at       timestamptz,
  CONSTRAINT workflow_runs_status_chk CHECK (
    status IN ('planning', 'running', 'completed', 'failed', 'cancelled')
  ),
  CONSTRAINT workflow_runs_output_format_chk CHECK (
    output_format IN ('json', 'csv')
  )
);

CREATE INDEX workflow_runs_org_status_idx ON agent.workflow_runs (org_id, workspace_id, status);
CREATE INDEX workflow_runs_org_idx ON agent.workflow_runs (org_id, workspace_id);

GRANT SELECT, INSERT, UPDATE ON agent.workflow_runs TO oxagen_app;

CREATE TABLE agent.workflow_run_tasks (
  id                 uuid PRIMARY KEY DEFAULT COALESCE(
                       CASE WHEN to_regprocedure('public.uuid_generate_v7()') IS NOT NULL
                         THEN uuid_generate_v7() ELSE uuid_generate_v4() END,
                       uuid_generate_v4()),
  public_id          citext NOT NULL UNIQUE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  created_by_user_id uuid,
  updated_by_user_id uuid,
  org_id             uuid NOT NULL,
  workspace_id       uuid NOT NULL,
  workflow_run_id    uuid NOT NULL REFERENCES agent.workflow_runs(id) ON DELETE CASCADE,
  task_index         integer NOT NULL,
  title              text NOT NULL,
  goal               text NOT NULL,
  status             citext NOT NULL DEFAULT 'pending',
  inngest_run_id     text,
  output_json        jsonb,
  error              text,
  started_at         timestamptz,
  completed_at       timestamptz,
  CONSTRAINT workflow_run_tasks_status_chk CHECK (
    status IN ('pending', 'running', 'completed', 'failed', 'cancelled')
  )
);

CREATE INDEX workflow_run_tasks_run_idx ON agent.workflow_run_tasks (workflow_run_id);
CREATE INDEX workflow_run_tasks_org_status_idx ON agent.workflow_run_tasks (org_id, workspace_id, status);
CREATE INDEX workflow_run_tasks_org_idx ON agent.workflow_run_tasks (org_id, workspace_id);

GRANT SELECT, INSERT, UPDATE ON agent.workflow_run_tasks TO oxagen_app;

-- RLS: rows are org-scoped (same pattern as all agent.* tables).
ALTER TABLE agent.workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent.workflow_run_tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY workflow_runs_org_isolation ON agent.workflow_runs
  USING (org_id = current_setting('app.current_org_id', true)::uuid);

CREATE POLICY workflow_run_tasks_org_isolation ON agent.workflow_run_tasks
  USING (org_id = current_setting('app.current_org_id', true)::uuid);
