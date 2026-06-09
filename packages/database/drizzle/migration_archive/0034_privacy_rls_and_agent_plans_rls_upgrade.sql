-- 0034: Add RLS to privacy GDPR tables + upgrade agent_plans to standard policy.
--
-- auth.privacy_export_requests and auth.privacy_erasure_requests were created
-- in migration 0033 without RLS. Both tables carry org_id NOT NULL but no
-- workspace_id, so they get an org-only policy matching the billing.* pattern.
-- The GET /privacy/export/:exportId route also receives a defense-in-depth
-- userId filter (apps/api/src/routes/v1/privacy.data.export.ts) in this same
-- commit.
--
-- agent.agent_plans was added in 0031 with an org-only predicate despite
-- having workspace_id NOT NULL and being declared policyClass='standard' in
-- POLICY_MANIFEST. Migration 0032 already demonstrated the correct pattern for
-- upgrading agent execution tables from org-only to standard. This migration
-- applies the same upgrade to agent_plans so that members in workspace W1
-- cannot read plans belonging to workspace W2 within the same org.
--
-- withTenantDb always sets both app.current_org_id and app.current_workspace_id
-- GUCs, so the standard predicate does not break any existing read/write path.

BEGIN;

-- ── auth.privacy_export_requests ─────────────────────────────────────────────
-- table: auth schema, org_id NOT NULL, no workspace_id → org-only policy.

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
-- table: auth schema, org_id NOT NULL, no workspace_id → org-only policy.

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
-- ENABLE/FORCE already applied in 0031. Dropping the weaker policy and
-- replacing it with the standard predicate matching POLICY_MANIFEST.

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
