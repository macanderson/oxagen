import { Command } from "commander";
import { apiRequest, requireAuth } from "../lib/api-client.js";

export const pluginUninstallCommand = new Command("uninstall")
  .description("Uninstall a plugin")
  .argument("<id>", "Plugin ID to uninstall")
  .option("--org <slug>", "Organization slug")
  .action(async (id: string, options: { org?: string }) => {
    requireAuth();
    try {
      await apiRequest("/plugins/uninstall", {
        method: "POST",
        body: JSON.stringify({ pluginId: id, org: options.org }),
      });
      console.log(`✓ Plugin ${id} uninstalled`);
    } catch (err) {
      console.error(`Error: ${String(err)}`);
      process.exit(1);
    }
  });
