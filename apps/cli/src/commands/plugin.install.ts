import { Command } from "commander";
import { apiRequest, requireAuth, ApiError } from "../lib/api-client.js";

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
      const _msg = err instanceof ApiError ? err.message : String(err); console.error(`Error: ${_msg}`);
      process.exit(1);
    }
  });
