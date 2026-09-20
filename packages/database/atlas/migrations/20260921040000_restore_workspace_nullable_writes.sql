-- Replay the reviewed shared-row policy for databases that advanced past its
-- original revision while that migration was absent from main. Keep the
-- original file unchanged so existing Atlas revision hashes remain valid.
-- Each table drops and recreates the same policies inside this migration.

ALTER TABLE billing.spend_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.spend_budgets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.spend_budgets;
DROP POLICY IF EXISTS tenant_org_wide_read ON billing.spend_budgets;
DROP POLICY IF EXISTS tenant_org_shared_read ON billing.spend_budgets;
CREATE POLICY tenant_isolation ON billing.spend_budgets
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid OR (workspace_id IS NULL AND nullif(current_setting('app.current_workspace_id', true), '')::uuid IS NULL))))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid OR (workspace_id IS NULL AND nullif(current_setting('app.current_workspace_id', true), '')::uuid IS NULL))));
CREATE POLICY tenant_org_wide_read ON billing.spend_budgets
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY tenant_org_shared_read ON billing.spend_budgets
  FOR SELECT
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id IS NULL);

ALTER TABLE billing.spend_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing.spend_counters FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON billing.spend_counters;
DROP POLICY IF EXISTS tenant_org_wide_read ON billing.spend_counters;
DROP POLICY IF EXISTS tenant_org_shared_read ON billing.spend_counters;
CREATE POLICY tenant_isolation ON billing.spend_counters
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid OR (workspace_id IS NULL AND nullif(current_setting('app.current_workspace_id', true), '')::uuid IS NULL))))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid OR (workspace_id IS NULL AND nullif(current_setting('app.current_workspace_id', true), '')::uuid IS NULL))));
CREATE POLICY tenant_org_wide_read ON billing.spend_counters
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY tenant_org_shared_read ON billing.spend_counters
  FOR SELECT
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id IS NULL);

ALTER TABLE iam.principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE iam.principals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON iam.principals;
DROP POLICY IF EXISTS tenant_org_wide_read ON iam.principals;
DROP POLICY IF EXISTS tenant_org_shared_read ON iam.principals;
CREATE POLICY tenant_isolation ON iam.principals
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid OR (workspace_id IS NULL AND nullif(current_setting('app.current_workspace_id', true), '')::uuid IS NULL))))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid OR (workspace_id IS NULL AND nullif(current_setting('app.current_workspace_id', true), '')::uuid IS NULL))));
CREATE POLICY tenant_org_wide_read ON iam.principals
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY tenant_org_shared_read ON iam.principals
  FOR SELECT
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id IS NULL);

ALTER TABLE iam.principal_role_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE iam.principal_role_assignments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON iam.principal_role_assignments;
DROP POLICY IF EXISTS tenant_org_wide_read ON iam.principal_role_assignments;
DROP POLICY IF EXISTS tenant_org_shared_read ON iam.principal_role_assignments;
CREATE POLICY tenant_isolation ON iam.principal_role_assignments
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid OR (workspace_id IS NULL AND nullif(current_setting('app.current_workspace_id', true), '')::uuid IS NULL))))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid OR (workspace_id IS NULL AND nullif(current_setting('app.current_workspace_id', true), '')::uuid IS NULL))));
CREATE POLICY tenant_org_wide_read ON iam.principal_role_assignments
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY tenant_org_shared_read ON iam.principal_role_assignments
  FOR SELECT
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id IS NULL);

ALTER TABLE iam.authorization_deny_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE iam.authorization_deny_generations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON iam.authorization_deny_generations;
DROP POLICY IF EXISTS tenant_org_wide_read ON iam.authorization_deny_generations;
DROP POLICY IF EXISTS tenant_org_shared_read ON iam.authorization_deny_generations;
CREATE POLICY tenant_isolation ON iam.authorization_deny_generations
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid OR (workspace_id IS NULL AND nullif(current_setting('app.current_workspace_id', true), '')::uuid IS NULL))))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid OR (workspace_id IS NULL AND nullif(current_setting('app.current_workspace_id', true), '')::uuid IS NULL))));
CREATE POLICY tenant_org_wide_read ON iam.authorization_deny_generations
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY tenant_org_shared_read ON iam.authorization_deny_generations
  FOR SELECT
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id IS NULL);

ALTER TABLE iam.emergency_denies ENABLE ROW LEVEL SECURITY;
ALTER TABLE iam.emergency_denies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON iam.emergency_denies;
DROP POLICY IF EXISTS tenant_org_wide_read ON iam.emergency_denies;
DROP POLICY IF EXISTS tenant_org_shared_read ON iam.emergency_denies;
CREATE POLICY tenant_isolation ON iam.emergency_denies
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid OR (workspace_id IS NULL AND nullif(current_setting('app.current_workspace_id', true), '')::uuid IS NULL))))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid OR (workspace_id IS NULL AND nullif(current_setting('app.current_workspace_id', true), '')::uuid IS NULL))));
CREATE POLICY tenant_org_wide_read ON iam.emergency_denies
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY tenant_org_shared_read ON iam.emergency_denies
  FOR SELECT
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id IS NULL);

ALTER TABLE iam.authorization_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE iam.authorization_decisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON iam.authorization_decisions;
DROP POLICY IF EXISTS tenant_org_wide_read ON iam.authorization_decisions;
DROP POLICY IF EXISTS tenant_org_shared_read ON iam.authorization_decisions;
CREATE POLICY tenant_isolation ON iam.authorization_decisions
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid OR (workspace_id IS NULL AND nullif(current_setting('app.current_workspace_id', true), '')::uuid IS NULL))))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid OR (workspace_id IS NULL AND nullif(current_setting('app.current_workspace_id', true), '')::uuid IS NULL))));
CREATE POLICY tenant_org_wide_read ON iam.authorization_decisions
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY tenant_org_shared_read ON iam.authorization_decisions
  FOR SELECT
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id IS NULL);

ALTER TABLE notification.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification.notifications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON notification.notifications;
DROP POLICY IF EXISTS tenant_org_wide_read ON notification.notifications;
DROP POLICY IF EXISTS tenant_org_shared_read ON notification.notifications;
CREATE POLICY tenant_isolation ON notification.notifications
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid OR (workspace_id IS NULL AND nullif(current_setting('app.current_workspace_id', true), '')::uuid IS NULL))))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid OR (workspace_id IS NULL AND nullif(current_setting('app.current_workspace_id', true), '')::uuid IS NULL))));
CREATE POLICY tenant_org_wide_read ON notification.notifications
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY tenant_org_shared_read ON notification.notifications
  FOR SELECT
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id IS NULL);

ALTER TABLE security.security_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE security.security_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON security.security_events;
DROP POLICY IF EXISTS tenant_org_wide_read ON security.security_events;
DROP POLICY IF EXISTS tenant_org_shared_read ON security.security_events;
CREATE POLICY tenant_isolation ON security.security_events
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid OR (workspace_id IS NULL AND nullif(current_setting('app.current_workspace_id', true), '')::uuid IS NULL))))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid OR (workspace_id IS NULL AND nullif(current_setting('app.current_workspace_id', true), '')::uuid IS NULL))));
CREATE POLICY tenant_org_wide_read ON security.security_events
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY tenant_org_shared_read ON security.security_events
  FOR SELECT
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id IS NULL);

ALTER TABLE workspace.routing_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace.routing_policy FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workspace.routing_policy;
DROP POLICY IF EXISTS tenant_org_wide_read ON workspace.routing_policy;
DROP POLICY IF EXISTS tenant_org_shared_read ON workspace.routing_policy;
CREATE POLICY tenant_isolation ON workspace.routing_policy
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid OR (workspace_id IS NULL AND nullif(current_setting('app.current_workspace_id', true), '')::uuid IS NULL))))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid OR (workspace_id IS NULL AND nullif(current_setting('app.current_workspace_id', true), '')::uuid IS NULL))));
CREATE POLICY tenant_org_wide_read ON workspace.routing_policy
  FOR SELECT
  USING (current_setting('app.org_wide', true) = 'on' AND org_id = nullif(current_setting('app.current_org_id', true), '')::uuid);
CREATE POLICY tenant_org_shared_read ON workspace.routing_policy
  FOR SELECT
  USING (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id IS NULL);
