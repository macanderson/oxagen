-- 0029_ingestion_rls.sql
--
-- Tenant RLS + app-role grants for the ingestion schema (SOC2 CC6.3 / OXA-RLS-ingestion).
--
-- The ingestion schema was introduced by migrations 0001–0004 AFTER the 0001_rls_policies
-- baseline ran and AFTER the 0005 oxagen_app role grant loop ran. Two gaps resulted,
-- both closed here:
--
--   1. DATA ISOLATION: five ingestion tables are tenant-scoped (org_id and/or
--      workspace_id NOT NULL) but shipped without any row-level security. Under
--      TENANT_RLS_ENFORCEMENT_ENABLED=true and the non-superuser oxagen_app role,
--      any unfiltered query leaks rows across tenants. The highest-severity gap is
--      ingestion.oauth_accounts, which stores AES-256-GCM-encrypted OAuth tokens
--      (access_token_enc, refresh_token_enc) and the plaintext provider_user_email
--      PII field — a cross-org read is a token-material exposure incident.
--
--   2. REACHABILITY: the 0005 grant loop enumerated 14 schemas and omitted the
--      ingestion schema. Under TENANT_RLS_ENFORCEMENT_ENABLED=true the non-superuser
--      oxagen_app role cannot USAGE/DML the ingestion schema, causing permission-denied
--      in production. We add USAGE + table/sequence DML + default privileges, exactly
--      mirroring the pattern from 0005 and 0010.
--
-- Policy classes (see packages/database/src/tenant-policy.manifest.ts):
--   ingestion.source_connections    standard  (org_id + workspace_id NOT NULL)
--   ingestion.entity_types          standard  (org_id + workspace_id NOT NULL)
--   ingestion.entity_type_mappings  standard  (org_id + workspace_id NOT NULL)
--   ingestion.deletion_jobs         standard  (org_id + workspace_id NOT NULL)
--   ingestion.oauth_accounts        org_only  (org_id NOT NULL, no workspace_id)
--
-- Child tables (auth_credentials, oauth_tokens, webhook_subscriptions,
-- setup_suggestions) have no direct org_id column; their isolation is transitive
-- through source_connections once RLS is applied to the parent. They are NOT added
-- to POLICY_MANIFEST because the CI manifest-coverage test only checks tables with
-- an org_id column.
--
-- Idempotent: ENABLE/FORCE are no-ops if already set; DROP POLICY IF EXISTS +
-- CREATE makes policy creation re-runnable; grants are additive.
-- Applied by: pnpm db:migrate via public._migrations.

SET search_path TO public;

BEGIN;

-- 1. oxagen_app schema usage + table/sequence DML on the ingestion schema.
DO $$
BEGIN
  EXECUTE 'GRANT USAGE ON SCHEMA ingestion TO oxagen_app';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ingestion TO oxagen_app';
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ingestion TO oxagen_app';
  -- Future objects created by the migrating role inherit these grants.
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA ingestion GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO oxagen_app';
  EXECUTE 'ALTER DEFAULT PRIVILEGES IN SCHEMA ingestion GRANT USAGE, SELECT ON SEQUENCES TO oxagen_app';
END $$;

-- 2. Tenant-isolation RLS policies (bypass-aware: app.rls_bypass='on' disables
--    filtering during seeding / withSystemDb paths, exactly like 0001 and 0010).

-- ingestion.source_connections — standard (org_id + workspace_id)
ALTER TABLE ingestion.source_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.source_connections FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ingestion.source_connections;
CREATE POLICY tenant_isolation ON ingestion.source_connections
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- ingestion.entity_types — standard (org_id + workspace_id)
ALTER TABLE ingestion.entity_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.entity_types FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ingestion.entity_types;
CREATE POLICY tenant_isolation ON ingestion.entity_types
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- ingestion.entity_type_mappings — standard (org_id + workspace_id)
ALTER TABLE ingestion.entity_type_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.entity_type_mappings FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ingestion.entity_type_mappings;
CREATE POLICY tenant_isolation ON ingestion.entity_type_mappings
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- ingestion.deletion_jobs — standard (org_id + workspace_id)
ALTER TABLE ingestion.deletion_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.deletion_jobs FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ingestion.deletion_jobs;
CREATE POLICY tenant_isolation ON ingestion.deletion_jobs
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- ingestion.oauth_accounts — org_only (org_id NOT NULL, no workspace_id column)
-- HIGHEST SEVERITY: stores AES-256-GCM-encrypted OAuth tokens and plaintext
-- provider_user_email PII. A cross-org read is a token-material exposure incident.
ALTER TABLE ingestion.oauth_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.oauth_accounts FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON ingestion.oauth_accounts;
CREATE POLICY tenant_isolation ON ingestion.oauth_accounts
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

COMMIT;
