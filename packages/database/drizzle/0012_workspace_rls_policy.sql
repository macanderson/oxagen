-- RLS for workspace.workspaces (OXA-1515 follow-up).
-- The table has org_id NOT NULL but no workspace_id, so it uses the org_only
-- policy class — same pattern as billing.subscriptions, org.org_users, etc.

ALTER TABLE workspace.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.workspaces FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workspace.workspaces;
CREATE POLICY tenant_isolation ON workspace.workspaces
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));
