import { Command } from "commander";
import { apiRequest, requireAuth, ApiError } from "../lib/api-client.js";
import { getOrgId } from "../lib/config.js";

export const pluginUninstallCommand = new Command("uninstall")
  .description("Uninstall a plugin")
  .argument("<id>", "Plugin ID to uninstall")
  .option("--org <slug>", "Organization slug")
  .action(async (id: string, options: { org?: string }) => {
    requireAuth();
    try {
      await apiRequest("/plugins/uninstall", {
        method: "POST",
        body: JSON.stringify({ pluginId: id, org: options.org ?? getOrgId() }),
      });
      console.log(`✓ Plugin ${id} uninstalled`);
    } catch (err) {
      const _msg = err instanceof ApiError ? err.message : String(err); console.error(`Error: ${_msg}`);
      process.exit(1);
    }
  });
