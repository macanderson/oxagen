import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getOrgId } from "../lib/config.js";

interface PluginDenylistRemoveResponse {
  ok: boolean;
}

export const pluginDenylistRemoveCommand = new Command("remove")
  .description("Remove a plugin server from the org denylist")
  .requiredOption("-s, --server <name>", "Plugin server name to remove from denylist")
  .option("-t, --type <type>", "Plugin type: mcp_server, integration, or content_tool (default: mcp_server)", "mcp_server")
  .option("-o, --org <id>", "Organization ID")
  .action(async (options: { server: string; type: string; org?: string }) => {
    try {
      const data = await apiRequest<PluginDenylistRemoveResponse>("/plugin/denylist/remove", {
        method: "POST",
        body: JSON.stringify({
          serverName: options.server,
          pluginType: options.type,
          org_id: options.org ?? getOrgId(),
        }),
      });
      console.log(data.ok ? `✓ ${options.server} removed from denylist` : "Failed to remove from denylist");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
