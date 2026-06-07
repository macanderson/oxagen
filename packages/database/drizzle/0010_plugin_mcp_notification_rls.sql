-- 0010_plugin_mcp_notification_rls.sql
--
-- Tenant RLS + app-role grants for the installable-plugins epic (OXA-1515 / SOC2 CC6.3).
--
-- Migration 0008 created three new Postgres schemas (mcp, plugin, notification)
-- and six tables AFTER the 0001 baseline + the 0005 oxagen_app role grants. Two
-- gaps resulted, both closed here:
--
--   1. DATA ISOLATION: plugin.org_listings, plugin.org_denylist, mcp.credentials
--      (encrypted OAuth tokens!), mcp.registries, and notification.notifications
--      are all tenant-scoped but shipped with NO row-level security — only
--      app-layer eq(org_id) filters guarded them. Any unfiltered query or direct
--      DB path leaked across tenants. We ENABLE + FORCE RLS and add bypass-aware
--      tenant_isolation policies matching the POLICY_MANIFEST policyClass.
--
--   2. REACHABILITY: the 0005 grant loop enumerates 14 schemas and omitted these
--      three. Under TENANT_RLS_ENFORCEMENT_ENABLED=true the non-superuser
--      oxagen_app role could not USAGE/DML them, risking permission-denied in
--      prod. We grant USAGE + table/sequence DML + default privileges, exactly
--      mirroring 0005 (RLS still gates which rows are visible).
--
-- Policy classes (see packages/database/src/tenant-policy.manifest.ts):
--   plugin.org_listings           org_only          (org_id NOT NULL)
--   plugin.org_denylist           org_only          (org_id NOT NULL)
--   mcp.credentials               standard          (org_id + workspace_id NOT NULL)
--   notification.notifications    workspace_nullable (org_id NOT NULL, workspace_id nullable)
--   mcp.registries                org_or_global     (org_id NULLABLE: NULL = global seed)
--   mcp.catalog_servers           — no org_id, shared catalog, intentionally unscoped
--
-- Idempotent: ENABLE/FORCE are no-ops if already set; DROP POLICY IF EXISTS +
-- CREATE makes policy creation re-runnable; grants are additive. The oxagen_app
-- role is guaranteed to exist (created unconditionally by 0005, which runs first).
-- Applied by: pnpm db:migrate via public._migrations.

SET search_path TO public;

BEGIN;

-- 1. oxagen_app schema usage + table/sequence DML on the three new schemas.
DO $$
DECLARE
  s text;
BEGIN
  FOREACH s IN ARRAY ARRAY['mcp', 'plugin', 'notification']
  LOOP
    EXECUTE format('GRANT USAGE ON SCHEMA %I TO oxagen_app', s);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO oxagen_app', s);
    EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO oxagen_app', s);
    -- Future objects created by the migrating role inherit these grants.
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO oxagen_app', s);
    EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO oxagen_app', s);
  END LOOP;
END $$;

-- 2. Tenant-isolation RLS policies (bypass-aware: app.rls_bypass='on' disables
--    filtering during seeding / withSystemDb paths, exactly like 0001).

-- plugin.org_listings — org_only
ALTER TABLE plugin.org_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin.org_listings FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON plugin.org_listings;
CREATE POLICY tenant_isolation ON plugin.org_listings
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

-- plugin.org_denylist — org_only
ALTER TABLE plugin.org_denylist ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin.org_denylist FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON plugin.org_denylist;
CREATE POLICY tenant_isolation ON plugin.org_denylist
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

-- mcp.credentials — standard (org_id + workspace_id)
ALTER TABLE mcp.credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp.credentials FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mcp.credentials;
CREATE POLICY tenant_isolation ON mcp.credentials
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid));

-- mcp.registries — org_or_global (NULL org_id = global default seed visible to all)
ALTER TABLE mcp.registries ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp.registries FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mcp.registries;
CREATE POLICY tenant_isolation ON mcp.registries
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id IS NULL OR org_id = nullif(current_setting('app.current_org_id', true), '')::uuid))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id IS NULL OR org_id = nullif(current_setting('app.current_org_id', true), '')::uuid));

-- notification.notifications — workspace_nullable (org_id NOT NULL, workspace_id nullable)
ALTER TABLE notification.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification.notifications FORCE  ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON notification.notifications;
CREATE POLICY tenant_isolation ON notification.notifications
  USING (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id IS NULL OR workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid)))
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on' OR (org_id = nullif(current_setting('app.current_org_id', true), '')::uuid AND (workspace_id IS NULL OR workspace_id = nullif(current_setting('app.current_workspace_id', true), '')::uuid)));

COMMIT;
