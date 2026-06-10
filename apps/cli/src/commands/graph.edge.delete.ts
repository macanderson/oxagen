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

export const graphEdgeDeleteCommand = new Command("edge-delete")
  .description("Delete a typed relationship between two KnowledgeNodes")
  .requiredOption("-f, --from-node-id <id>", "publicId of the source node")
  .requiredOption("-t, --to-node-id <id>", "publicId of the target node")
  .requiredOption(
    "-e, --edge-type <type>",
    `Type of relationship to delete. One of: ${EDGE_TYPES.join(", ")}`,
  )
  .option("-y, --yes", "Skip confirmation prompt")
  .action(async (options: Record<string, unknown>) => {
    try {
      if (!options.yes) {
        const readline = await import("node:readline");
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const confirmed = await new Promise<boolean>((resolve) => {
          rl.question(
            `Delete ${String(options.edgeType)} edge from ${String(options.fromNodeId)} to ${String(options.toNodeId)}? [y/N] `,
            (answer) => {
              rl.close();
              resolve(answer.toLowerCase() === "y");
            },
          );
        });
        if (!confirmed) {
          console.log("Aborted.");
          process.exit(0);
        }
      }

      const result = await apiRequest("/graph/edges", {
        method: "DELETE",
        body: JSON.stringify({
          fromNodeId: options.fromNodeId,
          toNodeId: options.toNodeId,
          edgeType: options.edgeType,
        }),
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error("Failed to delete graph edge:", error);
      process.exit(1);
    }
  });
