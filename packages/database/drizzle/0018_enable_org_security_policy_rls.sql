-- Enable RLS on security.org_security_policy (OXA-1515 compliance fix)
-- Migration 0017 issued FORCE ROW LEVEL SECURITY but omitted ENABLE, causing
-- the policy to be defined but never evaluated. This forward migration applies
-- the missing ENABLE directive so the tenant_isolation policy is enforced.

BEGIN;

ALTER TABLE security.org_security_policy ENABLE ROW LEVEL SECURITY;

COMMIT;
