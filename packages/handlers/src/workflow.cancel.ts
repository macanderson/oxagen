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
  const run = await withTenantDb((tx) =>
    tx.query.workflowRuns.findFirst({
      where: and(
        or(
          eq(schema.workflowRuns.id, input.workflowId),
          eq(schema.workflowRuns.publicId, input.workflowId),
        ),
        eq(schema.workflowRuns.orgId, ctx.orgId),
        eq(schema.workflowRuns.workspaceId, ctx.workspaceId),
      ),
      columns: { id: true, status: true },
    }),
  );

  if (!run) {
    logger.warn({ workflowId: input.workflowId, orgId: ctx.orgId }, "workflow.cancel: not found");
    throw new Error(`workflow not found: ${input.workflowId}`);
  }

  if (run.status === "completed" || run.status === "cancelled") {
    return { cancelled: false };
  }

  await withTenantDb((tx) =>
    tx
      .update(schema.workflowRuns)
      .set({ status: "cancelled", updatedByUserId: ctx.userId ?? undefined })
      .where(eq(schema.workflowRuns.id, run.id)),
  );

  // Signal Inngest to cancel in-flight task functions.
  await inngest.send({
    name: "agent/workflow.cancel",
    data: { orgId: ctx.orgId, workflowRunId: run.id },
  });

  logger.info(
    { workflowRunId: run.id, orgId: ctx.orgId },
    "workflow.cancel: cancelled",
  );

  return { cancelled: true };
};
