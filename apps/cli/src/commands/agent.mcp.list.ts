import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getOrgId } from "../lib/config.js";

interface McpServer {
  id: string;
  name: string;
  status: string;
}

interface McpListResponse {
  servers: McpServer[];
}

export const agentMcpListCommand = new Command("mcp:list")
  .description("List MCP servers in the agent runtime")
  .option("-o, --org <id>", "Organization ID (defaults to current org)")
  .action(async (options: { org?: string }) => {
    try {
      const params = new URLSearchParams();
      const orgId = options.org ?? getOrgId();
      if (orgId) params.append("org_id", orgId);
      const data = await apiRequest<McpListResponse>(
        `/agent/mcp/list?${params}`,
        { method: "GET" }
      );
      console.log("MCP Servers:");
      data.servers.forEach((s) => {
        console.log(`  ${s.name} (${s.id}): ${s.status}`);
      });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
