import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";

interface ApprovalResolveResponse {
  id: string;
  status: string;
}

export const agentApprovalResolveCommand = new Command("resolve")
  .description("Resolve an agent approval request")
  .requiredOption("-a, --approval <id>", "Approval request ID")
  .requiredOption("-d, --decision <decision>", "Decision (approve|reject)")
  .option("-r, --reason <reason>", "Reason for decision")
  .action(async (options: { approval: string; decision: string; reason?: string }) => {
    try {
      if (!["approve", "reject"].includes(options.decision)) {
        throw new Error("Decision must be 'approve' or 'reject'");
      }
      console.log(`Resolving approval ${options.approval} with ${options.decision}...`);
      const data = await apiRequest<ApprovalResolveResponse>(
        "/agent/approval/resolve",
        {
          method: "POST",
          body: JSON.stringify({
            approval_id: options.approval,
            decision: options.decision,
            reason: options.reason,
          }),
        }
      );
      console.log(`✓ Approval resolved (status: ${data.status})`);
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : String(err);
      console.error(`Error: ${msg}`);
      process.exit(1);
    }
  });
