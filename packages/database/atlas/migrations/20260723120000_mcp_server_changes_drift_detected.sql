-- Descriptor pinning (pin-or-fail-closed): the agent runtime now audits every
-- turn where an external MCP server's live tool descriptors drift from their
-- pinned mcp.tool_snapshots baseline. Widen the change_type CHECK to accept
-- the new 'drift_detected' audit row.
ALTER TABLE "security"."mcp_server_changes" DROP CONSTRAINT "mcp_server_changes_change_type_check";
ALTER TABLE "security"."mcp_server_changes" ADD CONSTRAINT "mcp_server_changes_change_type_check" CHECK (change_type = ANY (ARRAY['enable'::text, 'disable'::text, 'delete'::text, 'drift_detected'::text]));
