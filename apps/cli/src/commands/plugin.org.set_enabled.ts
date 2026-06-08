import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface PluginOrgSetEnabledResponse {
  ok: boolean;
}

export const pluginOrgSetEnabledCommand = new Command("set-enabled")
  .description("Toggle the enabled flag on an org-level plugin listing")
  .requiredOption("-l, --listing <id>", "Org listing ID")
  .requiredOption("--enabled <bool>", "Enable (true) or disable (false)")
  .option("-o, --org <id>", "Organization ID")
  .action(async (options: { listing: string; enabled: string; org?: string }) => {
    try {
      const enabled = options.enabled === "true" || options.enabled === "1";
      const data = await apiRequest<PluginOrgSetEnabledResponse>("/plugin/org/set_enabled", {
        method: "POST",
        body: JSON.stringify({
          orgListingId: options.listing,
          enabled,
          org_id: options.org,
        }),
      });
      console.log(data.ok ? `✓ Plugin listing ${options.listing} ${enabled ? "enabled" : "disabled"}` : "Operation failed");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
