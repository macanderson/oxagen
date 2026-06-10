import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface ResearchSwarmStatusResponse {
  swarmId: string;
  dispatchId: string;
  status: "running" | "complete" | "failed";
  completedTasks: number;
  totalTasks: number;
  results?: Array<{ query: string; resultCount: number }>;
}

export const researchSwarmStatusCommand = new Command("status")
  .description("Poll the status of a running research swarm")
  .requiredOption("-s, --swarm-id <id>", "Swarm ID returned by research.swarm.start")
  .action(async (options: { swarmId: string }) => {
    try {
      const params = new URLSearchParams({ swarmId: options.swarmId });
      const data = await apiRequest<ResearchSwarmStatusResponse>(
        `/research/swarm/status?${params}`,
        { method: "GET" },
      );
      console.log(`Swarm: ${data.swarmId}`);
      console.log(`  Status:   ${data.status}`);
      console.log(`  Progress: ${data.completedTasks}/${data.totalTasks} tasks`);
      if (data.results && data.results.length > 0) {
        console.log(`  Results:`);
        for (const r of data.results) {
          console.log(`    "${r.query}" → ${r.resultCount} results`);
        }
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
