import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getOrgId } from "../lib/config.js";

interface PluginRegistrySyncResponse {
  accepted: boolean;
}

export const pluginRegistrySyncCommand = new Command("sync")
  .description("Trigger an on-demand catalog sync for a registry")
  .requiredOption("-r, --registry <id>", "Registry ID")
  .option("-m, --mode <mode>", "Sync mode: full or incremental (default: incremental)", "incremental")
  .option("-o, --org <id>", "Organization ID")
  .action(async (options: { registry: string; mode: string; org?: string }) => {
    try {
      const data = await apiRequest<PluginRegistrySyncResponse>("/plugin/registry/sync", {
        method: "POST",
        body: JSON.stringify({
          registryId: options.registry,
          mode: options.mode,
          org_id: options.org ?? getOrgId(),
        }),
      });
      console.log(data.accepted ? `✓ Sync accepted for registry ${options.registry} (${options.mode})` : "Sync not accepted");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
