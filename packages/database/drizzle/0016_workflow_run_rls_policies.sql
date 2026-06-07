-- Add RLS policies for workflow_run tables (OXA-1515)
-- These tables exist in the schema but lacked the standard bypass-aware RLS policies.
BEGIN;

-- Update agent.workflow_runs with standard RLS policy
ALTER TABLE agent.workflow_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workflow_runs_org_isolation ON agent.workflow_runs;
DROP POLICY IF EXISTS tenant_isolation ON agent.workflow_runs;
CREATE POLICY tenant_isolation ON agent.workflow_runs
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- Update agent.workflow_run_tasks with standard RLS policy
ALTER TABLE agent.workflow_run_tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workflow_run_tasks_org_isolation ON agent.workflow_run_tasks;
DROP POLICY IF EXISTS tenant_isolation ON agent.workflow_run_tasks;
CREATE POLICY tenant_isolation ON agent.workflow_run_tasks
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

COMMIT;
