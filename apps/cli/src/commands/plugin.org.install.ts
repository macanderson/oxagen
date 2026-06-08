import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface PluginInstallResponse {
  id: string;
  name: string;
  status: string;
}

export const pluginOrgInstallCommand = new Command("plugin:install")
  .description("Install a plugin for the organization")
  .requiredOption("-n, --name <name>", "Plugin name or ID")
  .option("-o, --org <id>", "Organization ID (defaults to current org)")
  .action(async (options: { name: string; org?: string }) => {
    try {
      console.log(`Installing plugin ${options.name}...`);
      const data = await apiRequest<PluginInstallResponse>(
        "/plugin/org/install",
        {
          method: "POST",
          body: JSON.stringify({ plugin_name: options.name, org_id: options.org }),
        }
      );
      console.log(`✓ Plugin installed`);
      console.log(`  Name: ${data.name}`);
      console.log(`  Status: ${data.status}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
