import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getOrgId, getWorkspaceId } from "../lib/config.js";

interface PluginSettingsSetAuthAlertsResponse {
  ok: boolean;
}

export const pluginSettingsSetAuthAlertsCommand = new Command("set-auth-alerts")
  .description("Update the org MCP auth-alert notification setting")
  .requiredOption("--roles <list>", "Comma-separated roles to alert: Owner,Admin,Compliance,Billing")
  .option("--send-email <bool>", "Send email alerts (true/false, default: true)", "true")
  .option("-o, --org <id>", "Organization ID")
  .option("-w, --workspace <id>", "Workspace ID")
  .action(async (options: { roles: string; sendEmail: string; org?: string; workspace?: string }) => {
    try {
      const roles = options.roles.split(",").map((r) => r.trim()) as ("Owner" | "Admin" | "Compliance" | "Billing")[];
      const sendEmail = options.sendEmail !== "false" && options.sendEmail !== "0";
      const data = await apiRequest<PluginSettingsSetAuthAlertsResponse>("/plugin/settings/set_auth_alerts", {
        method: "POST",
        body: JSON.stringify({
          sendEmail,
          roles,
          org_id: options.org ?? getOrgId(),
          workspace_id: options.workspace ?? getWorkspaceId(),
        }),
      });
      console.log(data.ok ? `✓ Auth alert settings updated (roles: ${roles.join(", ")}, email: ${sendEmail})` : "Update failed");
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
