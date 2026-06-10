import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getOrgId } from "../lib/config.js";

interface AgentTaskBackgroundStartResponse {
  taskId: string;
  inngestRunId: string;
}

export const agentTaskBackgroundStartCommand = new Command("start")
  .description("Dispatch a long-running task as a durable background job")
  .requiredOption("-k, --kind <kind>", "Task kind identifier")
  .requiredOption("--payload <json>", "Task payload as JSON")
  .option("-l, --label <label>", "Human-readable label for the task")
  .option("-o, --org <id>", "Organization ID")
  .action(async (options: { kind: string; payload: string; label?: string; org?: string }) => {
    try {
      const payload = JSON.parse(options.payload) as unknown;
      const data = await apiRequest<AgentTaskBackgroundStartResponse>("/agent/task/background/start", {
        method: "POST",
        body: JSON.stringify({
          kind: options.kind,
          payload,
          label: options.label,
          org_id: options.org ?? getOrgId(),
        }),
      });
      console.log(`✓ Background task started`);
      console.log(`  Task ID:    ${data.taskId}`);
      console.log(`  Inngest ID: ${data.inngestRunId}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
