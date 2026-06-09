-- 0009_mcp_server_enabled.sql — workspace enable/disable toggle for installed MCP servers.
ALTER TABLE agent.mcp_servers ADD COLUMN enabled boolean NOT NULL DEFAULT true;
CREATE INDEX mcp_servers_enabled_idx ON agent.mcp_servers (workspace_id, enabled);
CREATE UNIQUE INDEX mcp_servers_ws_listing_uniq ON agent.mcp_servers (workspace_id, org_listing_id) WHERE org_listing_id IS NOT NULL;
