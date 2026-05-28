import { db, schema } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import type { CapabilityContext } from "../types.js";

export interface AgentPlanApproveInput {
  planId: string;
  decision: "approve" | "deny" | "amend";
  amendedSteps?: Array<{
    id: string;
    summary: string;
    intent: string;
    capability: string | null;
    inputPreview?: unknown;
    dependsOn: string[];
  }>;
  note?: string;
}

export interface AgentPlanApproveOutput {
  planId: string;
  status: "approved" | "denied" | "amended";
}

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
  await db()
    .update(schema.planSteps)
    .set({ status })
    .where(
      and(eq(schema.planSteps.id, input.planId), eq(schema.planSteps.tenantId, ctx.tenantId)),
    );
  // PG NOTIFY so a paused stream listening for this plan can resume.
  await db().execute(
    /* sql */ `SELECT pg_notify('agent_plan_resolved', '${JSON.stringify({ planId: input.planId, status }).replace(/'/g, "''")}')`,
  );
  return { planId: input.planId, status };
}
