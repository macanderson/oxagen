import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";

export const workspaceModelSettingsReadCommand = new Command("read")
  .description("Read model settings for a workspace")
  .option("-w, --workspace <slug>", "Workspace slug (uses current if not specified)")
  .action(async (options: Record<string, unknown>) => {
    try {
      const result = await apiRequest("/workspace/model-settings/read", {
        method: "POST",
        body: JSON.stringify({
          workspace: options.workspace,
        }),
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error("Failed to read model settings:", error);
      process.exit(1);
    }
  });
