-- Fix RLS policies for workflow_run tables to match standard pattern (OXA-1515)
-- The original 0014 policies lacked bypass support and workspace isolation.
-- This migration upgrades them to the standard bypass-aware, workspace-scoped pattern.
BEGIN;

ALTER TABLE agent.workflow_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workflow_runs_org_isolation ON agent.workflow_runs;
CREATE POLICY tenant_isolation ON agent.workflow_runs
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

ALTER TABLE agent.workflow_run_tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workflow_run_tasks_org_isolation ON agent.workflow_run_tasks;
CREATE POLICY tenant_isolation ON agent.workflow_run_tasks
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

COMMIT;
