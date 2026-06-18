-- Marketplace workspace-scoping migration (2026-06-17).
--
-- Summary of changes:
--   1. DROP mcp.catalog_servers (shared cache, replaced by installed_plugins inline data)
--   2. DROP plugin.org_denylist (removed from schema; denylist logic dropped)
--   3. mcp.registries — TRUNCATE (old nullable org_id + is_default_seed rows invalid);
--      ADD workspace_id NOT NULL, ADD is_default NOT NULL DEFAULT false;
--      DROP is_default_seed, last_synced_at, last_synced_cursor;
--      Rebuild indexes (org+workspace composite, url uniqueness, partial default uniqueness).
--      RLS: upgrade from org_or_global → standard (org_id + workspace_id both NOT NULL).
--   4. plugin.org_listings → RENAME TO installed_plugins; TRUNCATE (workspace_id was nullable);
--      SET workspace_id NOT NULL; DROP catalog_server_id;
--      Rebuild CHECK constraints (5 types; collapse content_tool+capability → agent_capability);
--      Rename indexes to installed_plugins_*.
--      RLS: upgrade from org_only → standard (org_id + workspace_id both NOT NULL).
--   5. Replay oxagen_app grants for both changed tables (guards against re-baseline drops).
--
-- Approved decision: CLEAN REBUILD — no backfill. Pre-launch, no live customers.
-- Do NOT edit after applying (atlas.sum checksum seals this file).

-- ─── 1. DROP mcp.catalog_servers ────────────────────────────────────────────
-- No org_id column; no RLS policy. CASCADE is safe — no FK references exist.
DROP TABLE IF EXISTS mcp.catalog_servers CASCADE;

-- ─── 2. DROP plugin.org_denylist ────────────────────────────────────────────
-- Has org_id + tenant_isolation policy; DROP TABLE CASCADE removes the policy too.
DROP TABLE IF EXISTS plugin.org_denylist CASCADE;

-- ─── 3. Rebuild mcp.registries ──────────────────────────────────────────────

-- Clean rebuild: all existing rows had nullable org_id (global seed) or the old
-- single-org shape — none are valid under the new org+workspace NOT NULL schema.
TRUNCATE mcp.registries;

-- Add new columns (before NOT NULL enforcement so the TRUNCATE already zeroed rows).
ALTER TABLE mcp.registries
  ADD COLUMN IF NOT EXISTS workspace_id UUID NOT NULL DEFAULT gen_random_uuid();

-- Remove the transient DEFAULT now that the column is populated (TRUNCATE → zero rows,
-- so there are no rows to fill; we just need NOT NULL satisfied at DDL time).
ALTER TABLE mcp.registries
  ALTER COLUMN workspace_id DROP DEFAULT;

ALTER TABLE mcp.registries
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

-- Make org_id NOT NULL (was nullable for global seed rows; all rows now truncated).
ALTER TABLE mcp.registries
  ALTER COLUMN org_id SET NOT NULL;

-- Drop obsolete columns.
ALTER TABLE mcp.registries
  DROP COLUMN IF EXISTS is_default_seed,
  DROP COLUMN IF EXISTS last_synced_at,
  DROP COLUMN IF EXISTS last_synced_cursor;

-- Rebuild indexes (old org_idx was single-column; new shape is composite org+workspace).
DROP INDEX IF EXISTS mcp.registries_org_idx;
CREATE INDEX registries_org_idx ON mcp.registries (org_id, workspace_id);

-- Composite unique: one registry URL per org+workspace.
CREATE UNIQUE INDEX IF NOT EXISTS registries_org_ws_url_uniq
  ON mcp.registries (org_id, workspace_id, base_url);

-- Partial unique: at most one default registry per org+workspace.
CREATE UNIQUE INDEX IF NOT EXISTS registries_org_ws_default_uniq
  ON mcp.registries (org_id, workspace_id)
  WHERE is_default = true;

-- RLS: upgrade from org_or_global (org_id IS NULL OR …) to standard (both NOT NULL required).
ALTER TABLE mcp.registries ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp.registries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mcp.registries;
CREATE POLICY tenant_isolation ON mcp.registries
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

-- ─── 4. Rebuild plugin.org_listings → plugin.installed_plugins ──────────────

-- Clean rebuild: workspace_id was nullable; all existing rows invalid under new NOT NULL schema.
TRUNCATE plugin.org_listings;

-- Drop old indexes before rename (index names are namespace-qualified; DROP before rename
-- avoids pg error when the table name changes out from under the index name reference).
DROP INDEX IF EXISTS plugin.org_listings_org_ws_type_name_uniq;
DROP INDEX IF EXISTS plugin.org_listings_org_ws_type_idx;

-- Drop old constraints (will be recreated with new type set).
ALTER TABLE plugin.org_listings DROP CONSTRAINT IF EXISTS org_listings_type_check;
ALTER TABLE plugin.org_listings DROP CONSTRAINT IF EXISTS org_listings_source_check;
ALTER TABLE plugin.org_listings DROP CONSTRAINT IF EXISTS org_listings_auth_kind_check;

-- Drop catalog_server_id column (removed in schema rebuild).
ALTER TABLE plugin.org_listings DROP COLUMN IF EXISTS catalog_server_id;

-- Set workspace_id NOT NULL (all rows truncated above; no backfill needed).
ALTER TABLE plugin.org_listings ALTER COLUMN workspace_id SET NOT NULL;

-- Rename table to installed_plugins.
ALTER TABLE plugin.org_listings RENAME TO installed_plugins;

-- Add new CHECK constraints with the 5-type set.
ALTER TABLE plugin.installed_plugins
  ADD CONSTRAINT installed_plugins_type_check
    CHECK (plugin_type IN ('agent_skill','agent_capability','mcp_server','knowledge_source','integration'));

ALTER TABLE plugin.installed_plugins
  ADD CONSTRAINT installed_plugins_source_check
    CHECK (source IN ('registry','custom','oxagen'));

ALTER TABLE plugin.installed_plugins
  ADD CONSTRAINT installed_plugins_auth_kind_check
    CHECK (auth_kind IN ('oauth','secret','none'));

-- Recreate indexes under new name prefix.
CREATE UNIQUE INDEX IF NOT EXISTS installed_plugins_org_ws_type_name_uniq
  ON plugin.installed_plugins (org_id, workspace_id, plugin_type, name);

CREATE INDEX IF NOT EXISTS installed_plugins_org_ws_type_idx
  ON plugin.installed_plugins (org_id, workspace_id, plugin_type);

-- RLS: upgrade from org_only (org_id only) to standard (org_id + workspace_id).
ALTER TABLE plugin.installed_plugins ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin.installed_plugins FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON plugin.installed_plugins;
CREATE POLICY tenant_isolation ON plugin.installed_plugins
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

-- ─── 5. Replay oxagen_app grants for renamed/changed tables ─────────────────
-- The regrant migration (20260612052000_regrant_oxagen_app.sql) uses a
-- pg_namespace loop that covers existing tables at the time it runs.
-- A future re-baseline could drop these grants; re-asserting them here
-- (idempotent: GRANT is a no-op when already in place) ensures they survive.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON mcp.registries TO oxagen_app';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON plugin.installed_plugins TO oxagen_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA mcp TO oxagen_app';
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA plugin TO oxagen_app';
  END IF;
END
$$;
