import type { CapabilityHandler } from "@oxagen/oxagen";
import { automationList } from "@oxagen/oxagen/contracts/automation.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, desc, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";

export const automationListHandler: CapabilityHandler<
  typeof automationList
> = async (_input, ctx) => {
  if (!ctx.userId) {
    logger.warn(
      { orgId: ctx.orgId },
      "automation.list: rejected — no authenticated user",
    );
    throw new Error("automation.list requires an authenticated user");
  }

  const rows = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.playbookTriggers.publicId,
        triggerType: schema.playbookTriggers.triggerType,
        isEnabled: schema.playbookTriggers.isEnabled,
        name: schema.playbooks.name,
        deletedAt: schema.playbooks.deletedAt,
      })
      .from(schema.playbookTriggers)
      .innerJoin(
        schema.playbooks,
        and(
          eq(schema.playbookTriggers.playbookId, schema.playbooks.id),
          isNull(schema.playbooks.deletedAt),
        ),
      )
      .where(
        and(
          eq(schema.playbookTriggers.orgId, ctx.orgId),
          eq(schema.playbookTriggers.workspaceId, ctx.workspaceId),
        ),
      )
      .orderBy(desc(schema.playbookTriggers.createdAt)),
  );

  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, count: rows.length },
    "automation.list: returned automations",
  );

  return rows.map((row) => ({
    id: row.publicId,
    name: row.name,
    status: row.isEnabled ? "active" : "inactive",
    triggerType: row.triggerType,
    triggers: [row.triggerType],
  }));
};
