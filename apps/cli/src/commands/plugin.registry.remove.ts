import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface PluginRegistryRemoveResponse {
  ok: boolean;
}

export const pluginRegistryRemoveCommand = new Command("remove")
  .description("Remove an org-added MCP registry source (the global default seed cannot be removed)")
  .requiredOption("-r, --registry <id>", "Registry ID to remove")
  .option("-o, --org <id>", "Organization ID")
  .action(async (options: { registry: string; org?: string }) => {
    try {
      const data = await apiRequest<PluginRegistryRemoveResponse>("/plugin/registry/remove", {
        method: "DELETE",
        body: JSON.stringify({
          registryId: options.registry,
          org_id: options.org,
        }),
      });
      console.log(data.ok ? `✓ Registry ${options.registry} removed` : "Failed to remove registry");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
