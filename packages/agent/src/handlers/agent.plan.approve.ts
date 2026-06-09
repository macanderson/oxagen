import { withTenantDb } from "@oxagen/database";
import { sql } from "drizzle-orm";
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
  _ctx: CapabilityContext,
): Promise<AgentPlanApproveOutput> {
  const status = DECISION_TO_STATUS[input.decision];
  // planSteps table dropped in migration 0026 (was never INSERTed, only UPDATE reference).
  // Emit NOTIFY for any client listening. Use drizzle sql tagged-template so planId/status
  // are bound parameters — no user-controlled string is ever concatenated into SQL.
  const payload = JSON.stringify({ planId: input.planId, status });
  await withTenantDb((tx) =>
    tx.execute(sql`select pg_notify(${"agent_plan_resolved"}, ${payload})`),
  );
  return { planId: input.planId, status };
}
