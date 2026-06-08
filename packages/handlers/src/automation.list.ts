import type { CapabilityHandler } from "@oxagen/oxagen";
import { automationList } from "@oxagen/oxagen/contracts/automation.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, desc, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";

export const automationListHandler: CapabilityHandler<typeof automationList> = async (
  _input,
  ctx,
) => {
  if (!ctx.userId) {
    logger.warn({ orgId: ctx.orgId }, "automation.list: rejected — no authenticated user");
    throw new Error("automation.list requires an authenticated user");
  }

  const rows = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.automations.publicId,
        name: schema.automations.name,
        status: schema.automations.status,
        triggerConfig: schema.automations.triggerConfig,
      })
      .from(schema.automations)
      .where(
        and(
          eq(schema.automations.orgId, ctx.orgId),
          eq(schema.automations.workspaceId, ctx.workspaceId),
          isNull(schema.automations.deletedAt),
        ),
      )
      .orderBy(desc(schema.automations.createdAt)),
  );

  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, count: rows.length },
    "automation.list: returned automations",
  );

  return rows.map((row) => ({
    id: row.publicId,
    name: row.name,
    status: row.status,
    triggers: Array.isArray(row.triggerConfig) ? (row.triggerConfig as string[]) : [],
  }));
};
