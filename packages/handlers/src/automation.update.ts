import type { CapabilityHandler } from "@oxagen/oxagen";
import { automationUpdate } from "@oxagen/oxagen/contracts/automation.update";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq } from "drizzle-orm";
import { logger } from "./logger";

// Edit an existing automation. The automation is a (playbookTriggers, playbooks)
// pair: name/description live on the playbook, the trigger configuration lives on
// the trigger row. Enable/disable is intentionally NOT handled here — that is the
// human-gated automation.enable / automation.disable path. Partial: an omitted
// field is left unchanged.
export const automationUpdateHandler: CapabilityHandler<
  typeof automationUpdate
> = async (input, ctx) => {
  if (!ctx.userId) {
    logger.warn(
      { orgId: ctx.orgId },
      "automation.update: rejected — no authenticated user",
    );
    throw new Error("automation.update requires an authenticated user");
  }
  const userId = ctx.userId;

  // Resolve the trigger scoped to this tenant (org + workspace).
  const trigger = await withTenantDb((tx) =>
    tx.query.playbookTriggers.findFirst({
      where: and(
        eq(schema.playbookTriggers.publicId, input.automation_id),
        eq(schema.playbookTriggers.orgId, ctx.orgId),
        eq(schema.playbookTriggers.workspaceId, ctx.workspaceId),
      ),
      columns: {
        id: true,
        playbookId: true,
        triggerType: true,
        isEnabled: true,
      },
    }),
  );

  if (!trigger) {
    throw new Error(
      `automation.update: trigger not found: ${input.automation_id}`,
    );
  }

  const playbookUpdates: Record<string, unknown> = {};
  if (input.name !== undefined) playbookUpdates.name = input.name;
  if (input.description !== undefined)
    playbookUpdates.description = input.description;

  // Apply playbook + trigger updates in one transaction, then read back the
  // canonical playbook fields for the response.
  const playbook = await withTenantDb(async (tx) => {
    if (Object.keys(playbookUpdates).length > 0) {
      await tx
        .update(schema.playbooks)
        .set({ ...playbookUpdates, updatedByUserId: userId })
        .where(
          and(
            eq(schema.playbooks.id, trigger.playbookId),
            eq(schema.playbooks.orgId, ctx.orgId),
          ),
        );
    }

    if (input.triggerConfig !== undefined) {
      await tx
        .update(schema.playbookTriggers)
        .set({ config: input.triggerConfig, updatedByUserId: userId })
        .where(eq(schema.playbookTriggers.id, trigger.id));
    }

    return tx.query.playbooks.findFirst({
      where: and(
        eq(schema.playbooks.id, trigger.playbookId),
        eq(schema.playbooks.orgId, ctx.orgId),
      ),
      columns: { name: true, description: true, status: true },
    });
  });

  if (!playbook) {
    throw new Error(
      `automation.update: playbook not found for trigger ${input.automation_id}`,
    );
  }

  logger.info(
    {
      automation_id: input.automation_id,
      triggerId: trigger.id,
      playbookId: trigger.playbookId,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      fields: Object.keys({
        ...playbookUpdates,
        ...(input.triggerConfig !== undefined ? { triggerConfig: true } : {}),
      }),
    },
    "automation.update: automation updated",
  );

  return {
    automation_id: input.automation_id,
    name: playbook.name,
    description: playbook.description ?? null,
    status: playbook.status,
    triggerType: trigger.triggerType,
    enabled: trigger.isEnabled,
  };
};
