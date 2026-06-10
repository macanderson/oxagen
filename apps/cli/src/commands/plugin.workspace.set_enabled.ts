import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getOrgId, getWorkspaceId } from "../lib/config.js";

interface PluginWorkspaceSetEnabledResponse {
  workspaceServerId: string | null;
}

export const pluginWorkspaceSetEnabledCommand = new Command("workspace-set-enabled")
  .description("Enable or disable a plugin server for this workspace")
  .requiredOption("-l, --listing <id>", "Org listing ID")
  .requiredOption("--enabled <bool>", "Enable (true) or disable (false)")
  .option("-o, --org <id>", "Organization ID")
  .option("-w, --workspace <id>", "Workspace ID")
  .action(async (options: { listing: string; enabled: string; org?: string; workspace?: string }) => {
    try {
      const enabled = options.enabled === "true" || options.enabled === "1";
      const data = await apiRequest<PluginWorkspaceSetEnabledResponse>("/plugin/workspace/set_enabled", {
        method: "POST",
        body: JSON.stringify({
          orgListingId: options.listing,
          enabled,
          org_id: options.org ?? getOrgId(),
          workspace_id: options.workspace ?? getWorkspaceId(),
        }),
      });
      const status = enabled ? "enabled" : "disabled";
      if (data.workspaceServerId) {
        console.log(`✓ Plugin ${status} for workspace: server ${data.workspaceServerId}`);
      } else {
        console.log(`✓ Plugin ${status} for workspace`);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
