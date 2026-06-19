import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getOrgId, getWorkspaceId } from "../lib/config.js";

interface AgentMcpSetEnabledResponse {
  mcpServerId: string;
  enabled: boolean;
  snapshotCount: number;
}

export const agentMcpSetEnabledCommand = new Command("set-enabled")
  .description("Enable or disable a registered external MCP server")
  .requiredOption("-s, --server <id>", "MCP server ID")
  .requiredOption("--enabled <bool>", "Enable (true) or disable (false) the server")
  .option("-o, --org <id>", "Organization ID")
  .option("-w, --workspace <id>", "Workspace ID")
  .action(async (options: { server: string; enabled: string; org?: string; workspace?: string }) => {
    try {
      if (!["true", "false"].includes(options.enabled)) {
        throw new Error("--enabled must be 'true' or 'false'");
      }
      const enabled = options.enabled === "true";
      const data = await apiRequest<AgentMcpSetEnabledResponse>("/agent/mcp-servers/set-enabled", {
        method: "POST",
        body: JSON.stringify({
          mcpServerId: options.server,
          enabled,
          org_id: options.org ?? getOrgId(),
          workspace_id: options.workspace ?? getWorkspaceId(),
        }),
      });
      console.log(
        `✓ MCP server ${data.mcpServerId} ${data.enabled ? "enabled" : "disabled"} (${data.snapshotCount} snapshot${data.snapshotCount === 1 ? "" : "s"})`,
      );
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
