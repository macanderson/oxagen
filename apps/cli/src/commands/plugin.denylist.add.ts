import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getOrgId } from "../lib/config.js";

interface PluginDenylistAddResponse {
  ok: boolean;
}

export const pluginDenylistAddCommand = new Command("add")
  .description("Add a plugin server to the org denylist")
  .requiredOption("-s, --server <name>", "Plugin server name to denylist")
  .option("-t, --type <type>", "Plugin type: mcp_server, integration, or content_tool (default: mcp_server)", "mcp_server")
  .option("-r, --reason <reason>", "Reason for denylisting")
  .option("-o, --org <id>", "Organization ID")
  .action(async (options: { server: string; type: string; reason?: string; org?: string }) => {
    try {
      const data = await apiRequest<PluginDenylistAddResponse>("/plugin/denylist/add", {
        method: "POST",
        body: JSON.stringify({
          serverName: options.server,
          pluginType: options.type,
          reason: options.reason,
          org_id: options.org ?? getOrgId(),
        }),
      });
      console.log(data.ok ? `✓ ${options.server} added to denylist` : "Failed to add to denylist");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
