import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface AgentTaskBackgroundReadResponse {
  taskId: string;
  kind: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  label: string | null;
  resultPayload: unknown;
  failureReason: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export const agentTaskBackgroundReadCommand = new Command("read")
  .description("Read the status, progress, and result of a background task")
  .requiredOption("-t, --task <id>", "Task ID")
  .option("-o, --org <id>", "Organization ID")
  .action(async (options: { task: string; org?: string }) => {
    try {
      const data = await apiRequest<AgentTaskBackgroundReadResponse>(`/agent/task/background/read?taskId=${encodeURIComponent(options.task)}`, {
        method: "GET",
      });
      console.log(`Task: ${data.taskId}`);
      console.log(`  Kind:   ${data.kind}`);
      console.log(`  Status: ${data.status}`);
      if (data.label) console.log(`  Label:  ${data.label}`);
      if (data.failureReason) console.log(`  Failure: ${data.failureReason}`);
      if (data.resultPayload) console.log(`  Result: ${JSON.stringify(data.resultPayload)}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
