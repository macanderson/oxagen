-- Add workspace_id to plugin.org_listings for workspace-scoped installs.
-- All new installs are workspace-scoped; org-level legacy rows keep NULL workspace_id.
ALTER TABLE plugin.org_listings ADD COLUMN IF NOT EXISTS workspace_id UUID NULL;

-- Drop the old unique index and replace with one that includes workspace_id.
-- NULLS NOT DISTINCT means (org_id, NULL, type, name) is unique — prevents dup org-level rows.
DROP INDEX IF EXISTS plugin.org_listings_org_type_name_uniq;
CREATE UNIQUE INDEX org_listings_org_ws_type_name_uniq
  ON plugin.org_listings(org_id, workspace_id, plugin_type, name)
  NULLS NOT DISTINCT;

-- Drop old secondary index and recreate with workspace dimension.
DROP INDEX IF EXISTS plugin.org_listings_org_type_idx;
CREATE INDEX org_listings_org_ws_type_idx ON plugin.org_listings(org_id, workspace_id, plugin_type);

-- Fix any existing registry rows where base_url already contains the /v0.1/servers path suffix.
-- The registry client appends /v0.1/servers to base_url, so the full path causes a doubled route.
UPDATE mcp.registries
SET base_url = 'https://registry.modelcontextprotocol.io'
WHERE base_url LIKE '%/v0.1/servers%';
