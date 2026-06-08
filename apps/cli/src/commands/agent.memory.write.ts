import { Command } from "commander";
import { apiRequest } from "../lib/api-client.js";

export const agentMemoryWriteCommand = new Command("write")
  .description("Record an observation in agent memory")
  .requiredOption("-a, --agent-id <id>", "Agent ID or name")
  .requiredOption("-t, --text <text>", "Observation text")
  .option("--tags <list>", "Comma-separated tags")
  .action(async (options: Record<string, unknown>) => {
    try {
      const result = await apiRequest("/agent/memory/write", {
        method: "POST",
        body: JSON.stringify({
          agentId: options.agentId,
          text: options.text,
          tags: options.tags ? String(options.tags).split(",") : undefined,
        }),
      });
      console.log(JSON.stringify(result, null, 2));
    } catch (error) {
      console.error("Failed to write memory:", error);
      process.exit(1);
    }
  });
