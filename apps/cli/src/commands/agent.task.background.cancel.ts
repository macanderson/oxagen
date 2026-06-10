import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getOrgId } from "../lib/config.js";

interface AgentTaskBackgroundCancelResponse {
  cancelled: boolean;
}

export const agentTaskBackgroundCancelCommand = new Command("cancel")
  .description("Cancel a running or pending background task")
  .requiredOption("-t, --task <id>", "Task ID")
  .option("-o, --org <id>", "Organization ID")
  .action(async (options: { task: string; org?: string }) => {
    try {
      const data = await apiRequest<AgentTaskBackgroundCancelResponse>("/agent/task/background/cancel", {
        method: "POST",
        body: JSON.stringify({
          taskId: options.task,
          org_id: options.org ?? getOrgId(),
        }),
      });
      if (data.cancelled) {
        console.log(`✓ Task ${options.task} cancelled`);
      } else {
        console.log(`Task ${options.task} could not be cancelled (may already be complete)`);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
