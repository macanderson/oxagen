-- Add RLS policy for org_security_policy table (OXA-1515)
BEGIN;

ALTER TABLE security.org_security_policy FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON security.org_security_policy;
CREATE POLICY tenant_isolation ON security.org_security_policy
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

COMMIT;
