import { Command } from "commander";
import { apiRequest, requireAuth } from "../lib/api-client.js";

export const pluginInstallCommand = new Command("install")
  .description("Install a plugin")
  .argument("<id>", "Plugin ID from catalog")
  .option("--org <slug>", "Organization slug")
  .action(async (id: string, options: { org?: string }) => {
    requireAuth();
    try {
      await apiRequest("/plugins/install", {
        method: "POST",
        body: JSON.stringify({ pluginId: id, org: options.org }),
      });
      console.log(`✓ Plugin ${id} installed`);
    } catch (err) {
      console.error(`Error: ${String(err)}`);
      process.exit(1);
    }
  });
