import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getOrgId } from "../lib/config.js";

interface WorkflowCancelResponse {
  cancelled: boolean;
}

export const workflowCancelCommand = new Command("cancel")
  .description("Cancel a running or planning workflow")
  .requiredOption("-w, --workflow <id>", "Workflow run public ID (wfr_*) or UUID")
  .option("-o, --org <id>", "Organization ID")
  .action(async (options: { workflow: string; org?: string }) => {
    try {
      const data = await apiRequest<WorkflowCancelResponse>("/workflow/cancel", {
        method: "POST",
        body: JSON.stringify({
          workflowId: options.workflow,
          org_id: options.org ?? getOrgId(),
        }),
      });
      console.log(data.cancelled ? `✓ Workflow ${options.workflow} cancelled` : `Workflow ${options.workflow} could not be cancelled`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
