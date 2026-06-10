import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";


export const pluginCredentialReauthCommand = new Command("reauth")
  .description("Re-authenticate plugin credentials")
  .requiredOption("-p, --plugin-id <id>", "Plugin ID")
  .option("-o, --org-scoped", "Re-authenticate org-level credentials")
  .action(async (options: Record<string, unknown>) => {
    try {
      const result = await apiRequest("/plugin/credential/reauth", {
        method: "POST",
        body: JSON.stringify({
          pluginId: options.pluginId,
          orgScoped: options.orgScoped || false,
        }),
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error("Failed to re-authenticate:", error);
      process.exit(1);
    }
  });
