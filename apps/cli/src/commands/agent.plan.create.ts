import { Command } from "commander";
import { apiRequest, ApiError } from "../lib/api-client.js";
import { getOrgId } from "../lib/config.js";

interface PlanTask {
  id: string;
  title: string;
  description?: string;
  parentTaskId?: string | null;
  dependsOn: string[];
  capability?: string | null;
  estimatedDurationMs?: number;
}

interface AgentPlanCreateResponse {
  planId: string;
  status: "draft" | "awaiting_approval";
  goals: string[];
  tasks: PlanTask[];
  approvalRequired: boolean;
  createdAt: string;
}

export const agentPlanCreateCommand = new Command("create")
  .description("Create a structured hierarchical execution plan with approval gates")
  .requiredOption("-g, --goals <json>", "JSON array of goal strings")
  .requiredOption("-t, --tasks <json>", "JSON array of task objects")
  .option("-c, --constraints <json>", "JSON array of constraint strings")
  .option("--no-approval", "Skip approval gate (plan starts as draft, not awaiting_approval)")
  .option("--message-id <id>", "Originating conversation message ID")
  .option("-o, --org <id>", "Organization ID")
  .action(
    async (options: {
      goals: string;
      tasks: string;
      constraints?: string;
      approval: boolean;
      messageId?: string;
      org?: string;
    }) => {
      try {
        const goals = JSON.parse(options.goals) as string[];
        const tasks = JSON.parse(options.tasks) as PlanTask[];
        const constraints = options.constraints
          ? (JSON.parse(options.constraints) as string[])
          : undefined;

        const data = await apiRequest<AgentPlanCreateResponse>("/agent/plans", {
          method: "POST",
          body: JSON.stringify({
            goals,
            tasks,
            constraints,
            approvalRequired: options.approval,
            messageId: options.messageId,
            org_id: options.org ?? getOrgId(),
          }),
        });

        console.log(`✓ Plan created: ${data.planId} (${data.status})`);
        console.log(`  Goals: ${data.goals.length}, Tasks: ${data.tasks.length}`);
        if (data.approvalRequired) {
          console.log(`  Awaiting approval via: oxagen agent plan approve --plan ${data.planId} --decision approve`);
        }
      } catch (err) {
        const msg = err instanceof ApiError ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    },
  );
