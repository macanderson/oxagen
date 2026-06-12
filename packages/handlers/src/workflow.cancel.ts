import type { CapabilityHandler } from "@oxagen/oxagen";
import { workflowCancel } from "@oxagen/oxagen/contracts/workflow.cancel";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, or } from "drizzle-orm";
import { inngest } from "@oxagen/inngest-functions/client";
import { logger } from "./logger";

export const workflowCancelHandler: CapabilityHandler<typeof workflowCancel> = async (
  input,
  ctx,
) => {
  const execution = await withTenantDb((tx) =>
    tx.query.agentExecutions.findFirst({
      where: and(
        or(
          eq(schema.agentExecutions.id, input.workflowId),
          eq(schema.agentExecutions.publicId, input.workflowId),
        ),
        eq(schema.agentExecutions.orgId, ctx.orgId),
        eq(schema.agentExecutions.workspaceId, ctx.workspaceId),
      ),
      columns: { id: true, status: true },
    }),
  );

  if (!execution) {
    logger.warn({ workflowId: input.workflowId, orgId: ctx.orgId }, "workflow.cancel: not found");
    throw new Error(`workflow not found: ${input.workflowId}`);
  }

  if (execution.status === "completed" || execution.status === "cancelled") {
    return { cancelled: false };
  }

  await withTenantDb((tx) =>
    tx
      .update(schema.agentExecutions)
      .set({ status: "cancelled", updatedByUserId: ctx.userId ?? undefined })
      .where(eq(schema.agentExecutions.id, execution.id)),
  );

  await inngest.send({
    name: "agent/workflow.cancel",
    data: { orgId: ctx.orgId, executionId: execution.id },
  });

  logger.info(
    { executionId: execution.id, orgId: ctx.orgId },
    "workflow.cancel: cancelled",
  );

  return { cancelled: true };
};
