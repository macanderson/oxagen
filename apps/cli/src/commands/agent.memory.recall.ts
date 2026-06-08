import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";

export const agentMemoryRecallCommand = new Command("recall")
  .description("Retrieve observations from agent memory")
  .requiredOption("-a, --agent-id <id>", "Agent ID or name")
  .requiredOption("-q, --query <text>", "Memory recall query")
  .option("-l, --limit <n>", "Max results", "10")
  .action(async (options: Record<string, unknown>) => {
    try {
      const result = await apiRequest("/agent/memory/recall", {
        method: "POST",
        body: JSON.stringify({
          agentId: options.agentId,
          query: options.query,
          limit: parseInt(String(options.limit), 10),
        }),
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error("Failed to recall memory:", error);
      process.exit(1);
    }
  });
