import { withTenantDb, schema } from "@oxagen/database";
import type { CapabilityContext } from "../types";
import { createApprovalRequest } from "../runtime/approval";
import type { AgentPlanCreateInput, AgentPlanCreateOutput } from "@oxagen/oxagen/contracts/agent.plan.create";

export type { AgentPlanCreateInput, AgentPlanCreateOutput };

export async function agentPlanCreateHandler(
  input: AgentPlanCreateInput,
  ctx: CapabilityContext,
): Promise<AgentPlanCreateOutput> {
  // Insert plan steps as pending; the approval row is the gate.
  const planRows = input.steps.map((s) => ({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    executionStepId: ctx.requestId,
    planStepKey: s.id,
    summary: s.summary,
    intent: s.intent,
    capabilityName: s.capability,
    inputPreview: (s.inputPreview ?? null) as object,
    dependsOn: s.dependsOn as object,
    status: "pending",
  }));
  const inserted = await withTenantDb((tx) =>
    tx.insert(schema.planSteps).values(planRows).returning({ id: schema.planSteps.id }),
  );
  const planId = inserted[0]?.id ?? ctx.requestId;
  await createApprovalRequest({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    messageId: input.parentMessageId,
    capabilityName: "agent.plan.create",
    inputPreview: { title: input.title, steps: input.steps, rationale: input.rationale ?? null },
    riskLevel: "low",
  });
  return { planId, status: "pending_approval" };
}
