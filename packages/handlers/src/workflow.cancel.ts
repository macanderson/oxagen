import type { CapabilityHandler } from "@oxagen/oxagen";
import { workflowCancel } from "@oxagen/oxagen/contracts/workflow.cancel";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, notInArray, or } from "drizzle-orm";
import { eventClient } from "./event-client";
import { logger } from "./logger";

// Terminal statuses an execution can never be cancelled out of. Kept in sync
// with the agent_executions_status_check constraint (planning | running |
// completed | failed | cancelled).
const TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;

export const workflowCancelHandler: CapabilityHandler<
  typeof workflowCancel
> = async (input, ctx) => {
  // Read the existence/status and flip to "cancelled" inside ONE transaction so
  // the status check and the write cannot interleave with the Inngest worker
  // transitioning the run to a terminal state (TOCTOU). The UPDATE itself carries
  // a status guard (notInArray TERMINAL_STATUSES) so it only flips a still-
  // cancellable row; .returning() tells us whether a row was actually flipped.
  const outcome = await withTenantDb(async (tx) => {
    const matchesWorkflow = and(
      or(
        eq(schema.agentExecutions.id, input.workflowId),
        eq(schema.agentExecutions.publicId, input.workflowId),
      ),
      eq(schema.agentExecutions.orgId, ctx.orgId),
      eq(schema.agentExecutions.workspaceId, ctx.workspaceId),
    );

    const execution = await tx.query.agentExecutions.findFirst({
      where: matchesWorkflow,
      columns: { id: true, status: true },
    });

    if (!execution) return { kind: "not_found" as const };

    const [updated] = await tx
      .update(schema.agentExecutions)
      .set({ status: "cancelled", updatedByUserId: ctx.userId ?? undefined })
      .where(
        and(
          matchesWorkflow,
          notInArray(schema.agentExecutions.status, [...TERMINAL_STATUSES]),
        ),
      )
      .returning({ id: schema.agentExecutions.id });

    // Zero rows flipped => the run reached a terminal status (already
    // completed/failed/cancelled, or transitioned there mid-cancel). Do not
    // corrupt the terminal state.
    if (!updated)
      return { kind: "already_terminal" as const, id: execution.id };

    return { kind: "cancelled" as const, id: updated.id };
  });

  if (outcome.kind === "not_found") {
    logger.warn(
      { workflowId: input.workflowId, orgId: ctx.orgId },
      "workflow.cancel: not found",
    );
    throw new Error(`workflow not found: ${input.workflowId}`);
  }

  if (outcome.kind === "already_terminal") {
    return { cancelled: false };
  }

  await eventClient.send({
    name: "agent/workflow.cancel",
    data: { orgId: ctx.orgId, executionId: outcome.id },
  });

  logger.info(
    { executionId: outcome.id, orgId: ctx.orgId },
    "workflow.cancel: cancelled",
  );

  return { cancelled: true };
};
