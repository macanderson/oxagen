import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";


export const pluginRegistryListCommand = new Command("list")
  .description("List available plugin registries")
  .option("-o, --org-scoped", "Show only org-scoped registries")
  .action(async (_options: Record<string, unknown>) => {
    try {
      const result = await apiRequest("/plugin/registry/list", {
        method: "GET",
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error("Failed to list registries:", error);
      process.exit(1);
    }
  });
