import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface PluginOrgListResponse {
  listings: Array<{
    id: string;
    publicId: string;
    name: string;
    pluginType: string;
    enabled: boolean;
  }>;
  denylist: Array<{
    id: string;
    serverName: string;
    pluginType: string;
    reason: string | null;
  }>;
}

export const pluginOrgListCommand = new Command("list-org")
  .description("List installed plugins and denylisted servers for the org")
  .option("-t, --type <type>", "Filter by plugin type: mcp_server, integration, or content_tool")
  .option("-o, --org <id>", "Organization ID")
  .action(async (options: { type?: string; org?: string }) => {
    try {
      const params = new URLSearchParams();
      if (options.type) params.append("pluginType", options.type);
      if (options.org) params.append("org_id", options.org);
      const data = await apiRequest<PluginOrgListResponse>(`/plugin/org/list?${params}`, {
        method: "GET",
      });
      console.log(`Org plugins (${data.listings.length}):`);
      for (const listing of data.listings) {
        const status = listing.enabled ? "enabled" : "disabled";
        console.log(`  ${listing.name} (${listing.publicId}) [${listing.pluginType}] — ${status}`);
      }
      if (data.denylist.length > 0) {
        console.log(`\nDenylist (${data.denylist.length}):`);
        for (const entry of data.denylist) {
          console.log(`  ${entry.serverName} [${entry.pluginType}]${entry.reason ? ` — ${entry.reason}` : ""}`);
        }
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
