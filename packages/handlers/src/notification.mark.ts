import { and, eq } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";
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
    await withTenantDb(async (tx) => {
      await tx
        .update(schema.notifications)
        .set(updates)
        .where(
          and(
            eq(schema.notifications.publicId, id),
            eq(schema.notifications.userId, ctx.userId!),
            eq(schema.notifications.orgId, ctx.orgId!),
          ),
        );
    });
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
