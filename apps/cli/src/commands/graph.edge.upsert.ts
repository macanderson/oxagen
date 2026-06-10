import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";

const EDGE_TYPES = [
  "RELATED_TO",
  "PART_OF",
  "CAUSED_BY",
  "REFERENCES",
  "SIMILAR_TO",
  "DEPENDS_ON",
  "CREATED_BY",
  "MENTIONS",
] as const;

export const graphEdgeUpsertCommand = new Command("edge-upsert")
  .description("Create or update a typed relationship between two KnowledgeNodes")
  .requiredOption("-f, --from-node-id <id>", "publicId of the source node")
  .requiredOption("-t, --to-node-id <id>", "publicId of the target node")
  .requiredOption(
    "-e, --edge-type <type>",
    `Relationship type. One of: ${EDGE_TYPES.join(", ")}`,
  )
  .option("-p, --properties <json>", "JSON object of string key-value metadata for the edge")
  .action(async (options: Record<string, unknown>) => {
    try {
      let properties: Record<string, string> | undefined;
      if (options.properties) {
        try {
          properties = JSON.parse(String(options.properties)) as Record<string, string>;
        } catch {
          console.error("Error: --properties must be valid JSON with string values.");
          process.exit(1);
        }
      }

      const result = await apiRequest("/graph/edges", {
        method: "POST",
        body: JSON.stringify({
          fromNodeId: options.fromNodeId,
          toNodeId: options.toNodeId,
          edgeType: options.edgeType,
          properties,
        }),
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error("Failed to upsert graph edge:", error);
      process.exit(1);
    }
  });
