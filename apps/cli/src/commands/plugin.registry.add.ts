import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";

export const pluginRegistryAddCommand = new Command("add")
  .description("Add a new plugin registry")
  .requiredOption("-n, --name <name>", "Registry name")
  .requiredOption("-u, --url <url>", "Registry URL")
  .option("-o, --org-scoped", "Make this an org-level registry")
  .action(async (options: Record<string, unknown>) => {
    try {
      const result = await apiRequest("/plugin/registry/add", {
        method: "POST",
        body: JSON.stringify({
          name: options.name,
          url: options.url,
          orgScoped: options.orgScoped || false,
        }),
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error("Failed to add registry:", error);
      process.exit(1);
    }
  });
