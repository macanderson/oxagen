import type { CapabilityHandler } from "@oxagen/oxagen";
import { automationTrigger } from "@oxagen/oxagen/contracts/automation.trigger";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";

export const automationTriggerHandler: CapabilityHandler<typeof automationTrigger> = async (
  input,
  ctx,
) => {
  if (!ctx.userId) {
    logger.warn({ orgId: ctx.orgId }, "automation.trigger: rejected — no authenticated user");
    throw new Error("automation.trigger requires an authenticated user");
  }

  const userId = ctx.userId;

  // Resolve the automation by publicId within this workspace (tenant-scoped via withTenantDb).
  const automation = await withTenantDb((tx) =>
    tx.query.automations.findFirst({
      where: and(
        eq(schema.automations.publicId, input.automation_id),
        eq(schema.automations.orgId, ctx.orgId),
        eq(schema.automations.workspaceId, ctx.workspaceId),
        isNull(schema.automations.deletedAt),
      ),
      columns: { id: true, publicId: true },
    }),
  );

  if (!automation) {
    throw new Error(`automation.trigger: automation not found: ${input.automation_id}`);
  }

  const [run] = await withTenantDb((tx) =>
    tx
      .insert(schema.automationRuns)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        automationId: automation.id,
        status: "running",
        payload: input.payload ?? {},
        startedAt: new Date(),
        createdByUserId: userId,
        updatedByUserId: userId,
      })
      .returning({
        publicId: schema.automationRuns.publicId,
        status: schema.automationRuns.status,
      }),
  );

  if (!run) throw new Error("automation.trigger: run insert returned no row");

  logger.info(
    {
      executionId: run.publicId,
      automationId: automation.id,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    },
    "automation.trigger: dispatched automation run",
  );

  return {
    execution_id: run.publicId,
    status: run.status,
  };
};
