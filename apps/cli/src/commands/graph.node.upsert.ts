import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";

export const graphNodeUpsertCommand = new Command("upsert")
  .description("Create or update a KnowledgeNode in the graph")
  .requiredOption("-l, --label <label>", "Node type (e.g. Person, Company, Topic)")
  .requiredOption("-n, --display-name <name>", "Human-readable display name")
  .option("-d, --description <text>", "Optional description or summary")
  .option("-e, --external-id <id>", "Stable external identifier for MERGE deduplication")
  .option("-p, --properties <json>", "JSON object of additional key-value metadata")
  .action(async (options: Record<string, unknown>) => {
    try {
      let properties: Record<string, unknown> | undefined;
      if (options.properties) {
        try {
          properties = JSON.parse(String(options.properties)) as Record<string, unknown>;
        } catch {
          console.error("Error: --properties must be valid JSON.");
          process.exit(1);
        }
      }

      const result = await apiRequest("/graph/nodes", {
        method: "POST",
        body: JSON.stringify({
          label: options.label,
          displayName: options.displayName,
          description: options.description,
          externalId: options.externalId,
          properties,
        }),
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error("Failed to upsert graph node:", error);
      process.exit(1);
    }
  });
