import type { CapabilityHandler } from "@oxagen/oxagen";
import { automationCreate } from "@oxagen/oxagen/contracts/automation.create";
import { schema, withTenantDb } from "@oxagen/database";
import { logger } from "./logger";

export const automationCreateHandler: CapabilityHandler<typeof automationCreate> = async (
  input,
  ctx,
) => {
  if (!ctx.userId) {
    logger.warn({ orgId: ctx.orgId }, "automation.create: rejected — no authenticated user");
    throw new Error("automation.create requires an authenticated user");
  }

  const userId = ctx.userId;

  const [row] = await withTenantDb((tx) =>
    tx
      .insert(schema.automations)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        name: input.name,
        status: "active",
        triggerConfig: input.trigger ? [input.trigger] : [],
        actionConfig: input.action ? { action: input.action } : {},
        createdByUserId: userId,
        updatedByUserId: userId,
      })
      .returning({
        publicId: schema.automations.publicId,
        name: schema.automations.name,
        status: schema.automations.status,
      }),
  );

  if (!row) throw new Error("automation.create: insert returned no row");

  logger.info(
    { publicId: row.publicId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    "automation.create: created automation",
  );

  return {
    automation_id: row.publicId,
    name: row.name,
    status: row.status,
  };
};
