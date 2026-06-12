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

  // Create the playbook shell, then a trigger for it.
  const [playbook] = await withTenantDb((tx) =>
    tx
      .insert(schema.playbooks)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        name: input.name,
        slug: input.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 80) || "automation",
        status: "draft",
        visibility: "workspace",
        createdByUserId: userId,
        updatedByUserId: userId,
      })
      .returning({ id: schema.playbooks.id }),
  );

  if (!playbook) throw new Error("automation.create: playbook insert returned no row");

  const triggerType = input.trigger?.includes("schedule") ? "schedule" : "api";

  const [trigger] = await withTenantDb((tx) =>
    tx
      .insert(schema.playbookTriggers)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        playbookId: playbook.id,
        triggerType,
        config: {
          trigger: input.trigger ?? null,
          action: input.action ?? null,
        },
        isEnabled: true,
        createdByUserId: userId,
        updatedByUserId: userId,
      })
      .returning({
        publicId: schema.playbookTriggers.publicId,
        triggerType: schema.playbookTriggers.triggerType,
        isEnabled: schema.playbookTriggers.isEnabled,
      }),
  );

  if (!trigger) throw new Error("automation.create: trigger insert returned no row");

  logger.info(
    { publicId: trigger.publicId, playbookId: playbook.id, orgId: ctx.orgId },
    "automation.create: created playbook trigger",
  );

  return {
    automation_id: trigger.publicId,
    name: input.name,
    status: trigger.isEnabled ? "active" : "inactive",
  };
};
