import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getOrgId } from "../lib/config.js";

interface WorkflowRun {
  id: string;
  publicId: string;
  title: string;
  status: "planning" | "running" | "completed" | "failed" | "cancelled";
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
}

interface WorkflowStatusResponse {
  workflow: WorkflowRun;
  tasks: Array<{
    id: string;
    title: string;
    status: "pending" | "running" | "completed" | "failed" | "cancelled";
  }>;
}

export const workflowStatusCommand = new Command("status")
  .description("Read current status and task progress of a workflow run")
  .requiredOption("-w, --workflow <id>", "Workflow run public ID (wfr_*) or UUID")
  .option("-o, --org <id>", "Organization ID")
  .action(async (options: { workflow: string; org?: string }) => {
    try {
      const params = new URLSearchParams({ workflowId: options.workflow });
      const orgId = options.org ?? getOrgId();
      if (orgId) params.append("org_id", orgId);
      const data = await apiRequest<WorkflowStatusResponse>(`/workflow/status?${params}`, {
        method: "GET",
      });
      const w = data.workflow;
      console.log(`Workflow: ${w.title} (${w.publicId})`);
      console.log(`  Status:   ${w.status}`);
      console.log(`  Progress: ${w.completedTasks}/${w.totalTasks} tasks (${w.failedTasks} failed)`);
      if (data.tasks.length > 0) {
        console.log(`  Tasks:`);
        for (const task of data.tasks) {
          console.log(`    [${task.status}] ${task.title}`);
        }
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
