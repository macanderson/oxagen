import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";

export const graphNodeSearchCommand = new Command("search")
  .description("Search KnowledgeNodes by text match on displayName and description")
  .requiredOption("-q, --query <text>", "Text to search for")
  .option(
    "-l, --labels <labels>",
    "Comma-separated list of node labels to filter by (e.g. Person,Company)",
  )
  .option("-n, --limit <n>", "Maximum number of results (1–50)", "10")
  .action(async (options: Record<string, unknown>) => {
    try {
      const labels = options.labels
        ? String(options.labels)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;

      const result = await apiRequest("/graph/nodes/search", {
        method: "POST",
        body: JSON.stringify({
          query: options.query,
          labels,
          limit: parseInt(String(options.limit), 10),
        }),
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error("Failed to search graph nodes:", error);
      process.exit(1);
    }
  });
