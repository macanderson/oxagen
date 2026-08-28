import { withTenantDb, schema } from "@oxagen/database";
import { eq, sql } from "drizzle-orm";
import type { CapabilityContext } from "../types";
import type {
  AgentPlanApproveInput,
  AgentPlanApproveOutput,
} from "@oxagen/oxagen/contracts/agent.plan.approve";

export type { AgentPlanApproveInput, AgentPlanApproveOutput };

const DECISION_TO_STATUS: Record<
  AgentPlanApproveInput["decision"],
  "approved" | "denied" | "amended"
> = {
  approve: "approved",
  deny: "denied",
  amend: "amended",
};

export async function agentPlanApproveHandler(
  input: AgentPlanApproveInput,
  ctx: CapabilityContext,
): Promise<AgentPlanApproveOutput> {
  const status = DECISION_TO_STATUS[input.decision];
  const now = new Date();
  // Payload for the NOTIFY that releases any agent stream waiting on this plan.
  // drizzle sql tagged-template binds planId/status as parameters — no
  // user-controlled string is ever concatenated into SQL.
  const payload = JSON.stringify({ planId: input.planId, status });

  await withTenantDb(async (tx) => {
    // Persist the decision on the plan row — this is the durable record of
    // resolution; the NOTIFY payload above only wakes a waiting stream, it
    // does not record anything. RLS scopes the UPDATE to the caller's
    // org+workspace, so a plan from another tenant matches zero rows and
    // 404s below.
    const amend =
      input.decision === "amend" && input.amendedSteps
        ? { tasks: input.amendedSteps, taskCount: input.amendedSteps.length }
        : {};
    const updated = await tx
      .update(schema.agentPlans)
      .set({
        status,
        // approved_at reflects a genuine approval only; deny/amend leave it null
        // until (and unless) a later approve fires.
        approvedAt: input.decision === "approve" ? now : null,
        // Records WHO resolved the plan (approver / denier / amender).
        approvedByUserId: ctx.userId ?? null,
        updatedByUserId: ctx.userId ?? null,
        updatedAt: now,
        ...amend,
      })
      .where(eq(schema.agentPlans.publicId, input.planId))
      .returning({ publicId: schema.agentPlans.publicId });

    if (updated.length === 0) {
      throw new Error(`Plan not found: ${input.planId}`);
    }

    // Emit NOTIFY for any client/stream listening for the resolution.
    await tx.execute(
      sql`select pg_notify(${"agent_plan_resolved"}, ${payload})`,
    );
  });

  return { planId: input.planId, status };
}
