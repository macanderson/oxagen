import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface WorkflowRunResponse {
  id: string;
  status: string;
  result?: Record<string, unknown>;
}

export const workflowRunCommand = new Command("run")
  .description("Run a workflow")
  .requiredOption("-w, --workflow <id>", "Workflow ID or name")
  .option("--input <json>", "Input parameters as JSON")
  .option("-o, --org <id>", "Organization ID (defaults to current org)")
  .action(async (options: { workflow: string; input?: string; org?: string }) => {
    try {
      let input: Record<string, unknown> = {};
      if (options.input) {
        try {
          input = JSON.parse(options.input) as Record<string, unknown>;
        } catch {
          throw new Error("Invalid input JSON");
        }
      }
      console.log(`Running workflow ${options.workflow}...`);
      const data = await apiRequest<WorkflowRunResponse>("/workflow/run", {
        method: "POST",
        body: JSON.stringify({
          workflow_id: options.workflow,
          input,
          org_id: options.org,
        }),
      });
      console.log(`✓ Workflow started`);
      console.log(`  Status: ${data.status}`);
      if (data.result) {
        console.log(`  Result: ${JSON.stringify(data.result)}`);
      }
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
