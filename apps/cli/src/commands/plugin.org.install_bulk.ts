import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface PluginOrgInstallBulkResponse {
  installed: Array<{
    catalogServerId: string | null;
    orgListingId: string | null;
    error: string | null;
  }>;
}

export const pluginOrgInstallBulkCommand = new Command("install-bulk")
  .description("Bulk install catalog or custom plugin servers to the org allow-list")
  .requiredOption("--items <json>", "Items as JSON array: [{pluginType?, catalogServerId?, custom?: {name, endpointUrl, transport, authKind}}]")
  .option("-o, --org <id>", "Organization ID")
  .action(async (options: { items: string; org?: string }) => {
    try {
      const items = JSON.parse(options.items) as unknown[];
      const data = await apiRequest<PluginOrgInstallBulkResponse>("/plugin/org/install_bulk", {
        method: "POST",
        body: JSON.stringify({
          items,
          org_id: options.org,
        }),
      });
      const succeeded = data.installed.filter((i) => !i.error).length;
      const failed = data.installed.filter((i) => i.error).length;
      console.log(`✓ Bulk install complete: ${succeeded} succeeded, ${failed} failed`);
      for (const item of data.installed) {
        if (item.error) {
          console.log(`  ✗ ${item.catalogServerId ?? "custom"}: ${item.error}`);
        } else {
          console.log(`  ✓ ${item.orgListingId}`);
        }
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
