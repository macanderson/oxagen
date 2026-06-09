import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";

export const pluginCatalogBrowseCommand = new Command("browse")
  .description("Browse the plugin catalog")
  .option("-c, --category <category>", "Filter by category")
  .option("-q, --query <search>", "Search query")
  .option("-p, --page <n>", "Page number", "1")
  .option("-l, --limit <n>", "Results per page", "20")
  .action(async (_options: Record<string, unknown>) => {
    try {
      const result = await apiRequest("/plugin/catalog/browse", {
        method: "GET",
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error("Failed to browse catalog:", error);
      process.exit(1);
    }
  });
