import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getOrgId, getWorkspaceId } from "../lib/config.js";

interface AgentMcpDeleteResponse {
  mcpServerId: string;
  deleted: boolean;
}

export const agentMcpDeleteCommand = new Command("delete")
  .description("Soft-delete a registered external MCP server")
  .requiredOption("-s, --server <id>", "MCP server ID")
  .option("-o, --org <id>", "Organization ID")
  .option("-w, --workspace <id>", "Workspace ID")
  .action(async (options: { server: string; org?: string; workspace?: string }) => {
    try {
      const data = await apiRequest<AgentMcpDeleteResponse>("/agent/mcp-servers/delete", {
        method: "POST",
        body: JSON.stringify({
          mcpServerId: options.server,
          org_id: options.org ?? getOrgId(),
          workspace_id: options.workspace ?? getWorkspaceId(),
        }),
      });
      console.log(`✓ MCP server ${data.mcpServerId} ${data.deleted ? "deleted" : "not deleted"}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
