-- Seed the official MCP registry as a global default (org_id = NULL).
-- This row is readable by every org via the tenant_isolation RLS policy:
--   USING (org_id IS NULL OR org_id = current_org_id)
-- The catalog-sync cron (plugin/registry.sync, every 6 h) picks it up
-- automatically; new orgs also trigger a one-shot sync on creation.
-- ON CONFLICT DO NOTHING is safe for re-runs / re-baseline.

INSERT INTO mcp.registries (
  id,
  public_id,
  org_id,
  name,
  base_url,
  enabled,
  is_default_seed,
  created_at,
  updated_at,
  created_by_user_id,
  updated_by_user_id
)
VALUES (
  gen_random_uuid(),
  'mreg_officialmcpregistryseed',
  NULL,
  'MCP Official Registry',
  'https://registry.modelcontextprotocol.io',
  true,
  true,
  now(),
  now(),
  NULL,
  NULL
)
ON CONFLICT DO NOTHING;
