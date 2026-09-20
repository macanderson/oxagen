import { and, eq, isNull } from "drizzle-orm";
import { schema, withOrgDb, withTenantDb } from "@oxagen/database";
import { ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen/types";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { id, read, archived } = input as {
    id: string;
    read?: boolean;
    archived?: boolean;
  };

  if (!ctx.userId) {
    throw new Error("[notifications.mark] userId is required (user-scoped)");
  }
  if (!ctx.orgId) {
    throw new Error("[notifications.mark] orgId is required (org-scoped)");
  }

  const updates: Partial<{
    unread: boolean;
    archived: boolean;
    updatedAt: Date;
  }> = {
    updatedAt: new Date(),
  };
  if (typeof read === "boolean") updates.unread = !read;
  if (typeof archived === "boolean") updates.archived = archived;

  if (Object.keys(updates).length === 1) {
    // Only updatedAt — no-op but valid.
    return { ok: true };
  }

  try {
    const ownership = and(
      eq(schema.notifications.publicId, id),
      eq(schema.notifications.userId, ctx.userId),
      eq(schema.notifications.orgId, ctx.orgId),
    );
    const shared = await withOrgDb((tx) =>
      tx
        .update(schema.notifications)
        .set(updates)
        .where(and(ownership, isNull(schema.notifications.workspaceId)))
        .returning({ id: schema.notifications.id }),
    );
    if (
      shared.length === 0 &&
      ctx.workspaceId &&
      ctx.workspaceId !== ORG_ONLY_WORKSPACE_ID
    ) {
      await withTenantDb((tx) =>
        tx.update(schema.notifications).set(updates).where(ownership),
      );
    }
  } catch (err) {
    logger.error(
      { err, id, orgId: ctx.orgId, userId: ctx.userId },
      "notifications.mark: failed",
    );
    throw err;
  }

  logger.info(
    { id, orgId: ctx.orgId, userId: ctx.userId },
    "notifications.mark: ok",
  );
  return { ok: true };
};
