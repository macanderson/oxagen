-- 0009: RLS for privacy GDPR tables + upgrade agent_plans to standard policy.
--
-- auth.privacy_export_requests and auth.privacy_erasure_requests were created in
-- 0008 without RLS. Both carry org_id NOT NULL but no workspace_id → org-only policy.
--
-- agent.agent_plans was added in 0005 with an org-only predicate despite having
-- workspace_id NOT NULL. This migration upgrades it to the standard org+workspace
-- predicate consistent with POLICY_MANIFEST policyClass='standard'.
--
-- Reference: migration_archive/0034_privacy_rls_and_agent_plans_rls_upgrade.sql
-- Idempotent: ENABLE/FORCE ROW LEVEL SECURITY are safe to repeat; DROP/CREATE policy.

BEGIN;

-- ── auth.privacy_export_requests ─────────────────────────────────────────────

ALTER TABLE auth.privacy_export_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.privacy_export_requests FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS privacy_export_requests_tenant_isolation ON auth.privacy_export_requests;

CREATE POLICY privacy_export_requests_tenant_isolation ON auth.privacy_export_requests
  USING (
    current_setting('app.rls_bypass', true) = 'on'
    OR org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    current_setting('app.rls_bypass', true) = 'on'
    OR org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
  );

GRANT SELECT, INSERT, UPDATE ON auth.privacy_export_requests TO oxagen_app;

-- ── auth.privacy_erasure_requests ────────────────────────────────────────────

ALTER TABLE auth.privacy_erasure_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.privacy_erasure_requests FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS privacy_erasure_requests_tenant_isolation ON auth.privacy_erasure_requests;

CREATE POLICY privacy_erasure_requests_tenant_isolation ON auth.privacy_erasure_requests
  USING (
    current_setting('app.rls_bypass', true) = 'on'
    OR org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
  )
  WITH CHECK (
    current_setting('app.rls_bypass', true) = 'on'
    OR org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
  );

GRANT SELECT, INSERT, UPDATE ON auth.privacy_erasure_requests TO oxagen_app;

-- ── agent.agent_plans — upgrade org-only → standard (org + workspace) ────────

DROP POLICY IF EXISTS agent_plans_tenant_isolation ON agent.agent_plans;

CREATE POLICY agent_plans_tenant_isolation ON agent.agent_plans
  USING (
    current_setting('app.rls_bypass', true) = 'on'
    OR (
      org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
      AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid
    )
  )
  WITH CHECK (
    current_setting('app.rls_bypass', true) = 'on'
    OR (
      org_id = nullif(current_setting('app.current_org_id', true), '')::uuid
      AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid
    )
  );

COMMIT;
