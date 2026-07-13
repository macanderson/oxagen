import { withTenantDb, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import type { CapabilityContext } from "../types";
import type {
  AgentPlanGetInput,
  AgentPlanGetOutput,
} from "@oxagen/oxagen/contracts/agent.plan.get";

export type { AgentPlanGetInput, AgentPlanGetOutput };

export async function agentPlanGetHandler(
  input: AgentPlanGetInput,
  _ctx: CapabilityContext,
): Promise<AgentPlanGetOutput> {
  // RLS (via withTenantDb's ambient tenant scope) limits the row to the
  // caller's org+workspace, so a foreign plan simply isn't found.
  const [row] = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.agentPlans.publicId,
        status: schema.agentPlans.status,
        goals: schema.agentPlans.goals,
        constraints: schema.agentPlans.constraints,
        tasks: schema.agentPlans.tasks,
        approvalRequired: schema.agentPlans.approvalRequired,
        approvedAt: schema.agentPlans.approvedAt,
        approvedByUserId: schema.agentPlans.approvedByUserId,
        taskCount: schema.agentPlans.taskCount,
        createdAt: schema.agentPlans.createdAt,
      })
      .from(schema.agentPlans)
      .where(eq(schema.agentPlans.publicId, input.planId))
      .limit(1),
  );

  if (!row) throw new Error(`Plan not found: ${input.planId}`);

  return {
    planId: row.publicId,
    status: row.status,
    goals: (row.goals as string[]) ?? [],
    constraints: (row.constraints as string[]) ?? [],
    tasks: (row.tasks as unknown[]) ?? [],
    approvalRequired: row.approvalRequired,
    approvedAt: row.approvedAt ? row.approvedAt.toISOString() : null,
    approvedByUserId: row.approvedByUserId ?? null,
    taskCount: row.taskCount,
    createdAt: row.createdAt.toISOString(),
  };
}
