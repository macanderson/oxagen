-- Widen plugin.installed_plugins.plugin_type CHECK to include 'mcp_server_local'.
--
-- 'mcp_server_local' (the local-file MCP runtime type) was already in
-- PLUGIN_TYPES and is used by packages/agent/src/runtime/plugin-types/file-mcp.ts,
-- but the installed_plugins type CHECK (and the in-code Drizzle CHECK) still
-- listed only five values — a merged drift that bricks inserting a local-MCP
-- plugin and trips the plugin-schema sync test. This brings the live constraint
-- into sync with PLUGIN_TYPES / the Drizzle schema. Idempotent: DROP IF EXISTS
-- then re-ADD the full six-value list.
ALTER TABLE plugin.installed_plugins DROP CONSTRAINT IF EXISTS installed_plugins_type_check;
ALTER TABLE plugin.installed_plugins ADD CONSTRAINT installed_plugins_type_check
  CHECK (plugin_type IN ('agent_skill','agent_capability','mcp_server','mcp_server_local','knowledge_source','integration'));
