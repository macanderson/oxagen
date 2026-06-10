import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";

export const graphNodeDeleteCommand = new Command("delete")
  .description("Delete a KnowledgeNode and all its relationships")
  .requiredOption("-i, --node-id <id>", "publicId of the node to delete")
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
            `Delete node ${String(options.nodeId)} and all its relationships? [y/N] `,
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

      const result = await apiRequest(
        `/graph/nodes/${encodeURIComponent(String(options.nodeId))}`,
        { method: "DELETE" },
      );
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error("Failed to delete graph node:", error);
      process.exit(1);
    }
  });
