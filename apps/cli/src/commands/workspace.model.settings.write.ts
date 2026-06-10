import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";
import { getWorkspaceId } from "../lib/config.js";

export const workspaceModelSettingsWriteCommand = new Command("write")
  .description("Update model settings for a workspace")
  .requiredOption("-k, --key <key>", "Setting key")
  .requiredOption("-v, --value <value>", "Setting value")
  .option("-w, --workspace <slug>", "Workspace slug (uses current if not specified)")
  .action(async (options: Record<string, unknown>) => {
    try {
      const result = await apiRequest("/workspace/model-settings/write", {
        method: "POST",
        body: JSON.stringify({
          workspace: options.workspace ?? getWorkspaceId(),
          key: options.key,
          value: options.value,
        }),
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error("Failed to write model settings:", error);
      process.exit(1);
    }
  });
