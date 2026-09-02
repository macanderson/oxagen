import { withTenantDb, schema } from "@oxagen/database";
import type { CapabilityContext } from "../types";
import type {
  AgentPlanCreateInput,
  AgentPlanCreateOutput,
} from "@oxagen/oxagen/contracts/agent.plan.create";

export type { AgentPlanCreateInput, AgentPlanCreateOutput };

export async function agentPlanCreateHandler(
  input: AgentPlanCreateInput,
  ctx: CapabilityContext,
): Promise<AgentPlanCreateOutput> {
  if (input.tasks.length > 100) {
    throw new Error("Plans are limited to 100 tasks");
  }

  const taskIds = new Set(input.tasks.map((t) => t.id));
  for (const task of input.tasks) {
    for (const dep of task.dependsOn) {
      if (!taskIds.has(dep)) {
        throw new Error(`Task "${task.id}" depends on unknown task "${dep}"`);
      }
    }
    if (task.parentTaskId != null && !taskIds.has(task.parentTaskId)) {
      throw new Error(
        `Task "${task.id}" references unknown parent "${task.parentTaskId}"`,
      );
    }
  }

  const status = input.approvalRequired ? "awaiting_approval" : "draft";

  const [row] = await withTenantDb((tx) =>
    tx
      .insert(schema.agentPlans)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        status,
        goals: input.goals,
        constraints: input.constraints,
        tasks: input.tasks,
        approvalRequired: input.approvalRequired,
        messageId: input.messageId ?? null,
        taskCount: input.tasks.length,
        createdByUserId: ctx.userId ?? null,
        updatedByUserId: ctx.userId ?? null,
      })
      .returning({
        publicId: schema.agentPlans.publicId,
        createdAt: schema.agentPlans.createdAt,
      }),
  );
  if (!row) throw new Error("agent_plans insert failed");

  return {
    planId: row.publicId,
    status,
    goals: input.goals,
    tasks: input.tasks,
    approvalRequired: input.approvalRequired,
    createdAt: row.createdAt.toISOString(),
  };
}
