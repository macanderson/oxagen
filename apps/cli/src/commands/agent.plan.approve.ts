import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface AgentPlanApproveResponse {
  planId: string;
  status: "approved" | "denied" | "amended";
}

export const agentPlanApproveCommand = new Command("approve")
  .description("Approve, deny, or amend a previously-proposed agent plan")
  .requiredOption("-p, --plan <id>", "Plan ID")
  .requiredOption("-d, --decision <decision>", "Decision: approve, deny, or amend")
  .option("--note <note>", "Optional note")
  .option("--amended-steps <json>", "Amended steps as JSON array (required when decision is amend)")
  .option("-o, --org <id>", "Organization ID")
  .action(async (options: { plan: string; decision: string; note?: string; amendedSteps?: string; org?: string }) => {
    try {
      let amendedSteps: unknown[] | undefined;
      if (options.amendedSteps) {
        amendedSteps = JSON.parse(options.amendedSteps) as unknown[];
      }
      const data = await apiRequest<AgentPlanApproveResponse>("/agent/plan/approve", {
        method: "POST",
        body: JSON.stringify({
          planId: options.plan,
          decision: options.decision,
          note: options.note,
          amendedSteps,
          org_id: options.org,
        }),
      });
      console.log(`✓ Plan ${data.status}: ${data.planId}`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
