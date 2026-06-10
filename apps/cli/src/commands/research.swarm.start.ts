import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface ResearchSwarmStartResponse {
  swarmId: string;
  dispatchId: string;
  status: "running";
  estimatedTasks: number;
}

export const researchSwarmStartCommand = new Command("start")
  .description("Fan out parallel web searches to research a topic")
  .requiredOption("-t, --topic <topic>", "Research topic")
  .option(
    "-d, --depth <depth>",
    "Research depth: shallow (3 queries), medium (8 queries), deep (15 queries)",
    "medium",
  )
  .option("--max-parallel <n>", "Maximum concurrent search tasks (1–20)", "5")
  .option("--target-label <label>", "KnowledgeNode label for top-level results", "Topic")
  .option("--search-depth <mode>", "Search mode: basic or advanced", "basic")
  .action(
    async (options: {
      topic: string;
      depth: string;
      maxParallel: string;
      targetLabel: string;
      searchDepth: string;
    }) => {
      try {
        const data = await apiRequest<ResearchSwarmStartResponse>("/research/swarm/start", {
          method: "POST",
          body: JSON.stringify({
            topic: options.topic,
            depth: options.depth,
            maxParallel: parseInt(options.maxParallel, 10),
            targetLabel: options.targetLabel,
            searchDepth: options.searchDepth,
          }),
        });
        console.log(`Research swarm started`);
        console.log(`  Swarm ID:   ${data.swarmId}`);
        console.log(`  Dispatch ID: ${data.dispatchId}`);
        console.log(`  Status:     ${data.status}`);
        console.log(`  Tasks:      ${data.estimatedTasks}`);
        console.log(`\nPoll status with: oxagen research swarm status --swarm-id ${data.swarmId}`);
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    },
  );
