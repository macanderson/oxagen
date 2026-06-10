import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";

export const graphNodeGetCommand = new Command("get")
  .description("Retrieve a KnowledgeNode by its publicId")
  .requiredOption("-i, --node-id <id>", "publicId of the node to retrieve")
  .action(async (options: Record<string, unknown>) => {
    try {
      const result = await apiRequest(
        `/graph/nodes/${encodeURIComponent(String(options.nodeId))}`,
        { method: "GET" },
      );
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error("Failed to get graph node:", error);
      process.exit(1);
    }
  });
