import type { CapabilityHandler } from "@oxagen/oxagen";
import { automationEnable } from "@oxagen/oxagen/contracts/automation.enable";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";

export const automationEnableHandler: CapabilityHandler<
  typeof automationEnable
> = async (input, ctx) => {
  if (!ctx.userId) {
    logger.warn(
      { orgId: ctx.orgId },
      "automation.enable: rejected — no authenticated user",
    );
    throw new Error("automation.enable requires an authenticated user");
  }

  const userId = ctx.userId;

  // Resolve the trigger scoped to this tenant.
  const trigger = await withTenantDb((tx) =>
    tx.query.playbookTriggers.findFirst({
      where: and(
        eq(schema.playbookTriggers.publicId, input.automation_id),
        eq(schema.playbookTriggers.orgId, ctx.orgId),
        eq(schema.playbookTriggers.workspaceId, ctx.workspaceId),
      ),
      columns: { id: true, publicId: true, playbookId: true },
    }),
  );

  if (!trigger) {
    throw new Error(
      `automation.enable: trigger not found: ${input.automation_id}`,
    );
  }

  // Enable the trigger and set the playbook status to active in one transaction.
  await withTenantDb(async (tx) => {
    await tx
      .update(schema.playbookTriggers)
      .set({ isEnabled: true, updatedByUserId: userId })
      .where(eq(schema.playbookTriggers.id, trigger.id));

    await tx
      .update(schema.playbooks)
      .set({ status: "active", updatedByUserId: userId })
      .where(
        and(
          eq(schema.playbooks.id, trigger.playbookId),
          eq(schema.playbooks.orgId, ctx.orgId),
        ),
      );
  });

  logger.info(
    {
      publicId: input.automation_id,
      triggerId: trigger.id,
      playbookId: trigger.playbookId,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      userId,
    },
    "automation.enable: trigger enabled",
  );

  return {
    automation_id: input.automation_id,
    enabled: true,
    status: "active",
  };
};
