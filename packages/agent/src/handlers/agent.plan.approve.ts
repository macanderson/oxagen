import { withTenantDb, schema } from "@oxagen/database";
import { and, eq, sql } from "drizzle-orm";
import type { CapabilityContext } from "../types";
import type { AgentPlanApproveInput, AgentPlanApproveOutput } from "@oxagen/oxagen/contracts/agent.plan.approve";

export type { AgentPlanApproveInput, AgentPlanApproveOutput };

const DECISION_TO_STATUS: Record<AgentPlanApproveInput["decision"], "approved" | "denied" | "amended"> = {
  approve: "approved",
  deny: "denied",
  amend: "amended",
};

export async function agentPlanApproveHandler(
  input: AgentPlanApproveInput,
  ctx: CapabilityContext,
): Promise<AgentPlanApproveOutput> {
  const status = DECISION_TO_STATUS[input.decision];
  // Tenant guard in the WHERE keeps the update from crossing scope.
  await withTenantDb((tx) =>
    tx
      .update(schema.planSteps)
      .set({ status })
      .where(
        and(eq(schema.planSteps.id, input.planId), eq(schema.planSteps.orgId, ctx.orgId)),
      ),
  );
  // PG NOTIFY so a paused stream listening for this plan can resume.
  // Use drizzle sql tagged-template so planId/status are bound parameters —
  // no user-controlled string is ever concatenated into SQL.
  const payload = JSON.stringify({ planId: input.planId, status });
  await withTenantDb((tx) =>
    tx.execute(sql`select pg_notify(${"agent_plan_resolved"}, ${payload})`),
  );
  return { planId: input.planId, status };
}
