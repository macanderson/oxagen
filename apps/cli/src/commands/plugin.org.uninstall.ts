import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getOrgId } from "../lib/config.js";

interface UninstallResponse {
  id: string;
  status: string;
}

export const pluginOrgUninstallCommand = new Command("plugin:uninstall")
  .description("Uninstall a plugin from the organization")
  .requiredOption("-p, --plugin <id>", "Plugin ID")
  .option("-o, --org <id>", "Organization ID (defaults to current org)")
  .action(async (options: { plugin: string; org?: string }) => {
    try {
      console.log(`Uninstalling plugin ${options.plugin}...`);
      const data = await apiRequest<UninstallResponse>(
        "/plugin/org/uninstall",
        {
          method: "POST",
          body: JSON.stringify({ plugin_id: options.plugin, org_id: options.org ?? getOrgId() }),
        }
      );
      console.log(`✓ Plugin uninstalled (status: ${data.status})`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
