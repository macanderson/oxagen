import { and, eq, count, sql } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { logger } from "./logger";

export const handler: CapabilityHandlerFn = async (input, ctx) => {
  const { unreadOnly, limit } = input as { unreadOnly: boolean; limit: number };

  if (!ctx.userId) {
    throw new Error("[notifications.list] userId is required (user-scoped)");
  }
  if (!ctx.orgId) {
    throw new Error("[notifications.list] orgId is required (org-scoped)");
  }
  const userId = ctx.userId;
  const orgId = ctx.orgId;

  try {
    return await withTenantDb(async (tx) => {
      const conditions = [
        eq(schema.notifications.userId, userId),
        eq(schema.notifications.orgId, orgId),
        eq(schema.notifications.archived, false),
      ];
      if (unreadOnly) {
        conditions.push(eq(schema.notifications.unread, true));
      }
      const where = and(...conditions);

      const [rows, countRows] = await Promise.all([
        tx
          .select({
            id: schema.notifications.id,
            publicId: schema.notifications.publicId,
            kind: schema.notifications.kind,
            title: schema.notifications.title,
            body: schema.notifications.body,
            deepLink: schema.notifications.deepLink,
            unread: schema.notifications.unread,
            archived: schema.notifications.archived,
            createdAt: schema.notifications.createdAt,
          })
          .from(schema.notifications)
          .where(where)
          .orderBy(sql`${schema.notifications.createdAt} DESC`)
          .limit(limit),
        tx
          .select({ n: count() })
          .from(schema.notifications)
          .where(
            and(
              eq(schema.notifications.userId, userId),
              eq(schema.notifications.orgId, orgId),
              eq(schema.notifications.archived, false),
              eq(schema.notifications.unread, true),
            ),
          ),
      ]);

      const countRow = countRows[0];
      const unreadCount = countRow?.n ?? 0;

      logger.info(
        { orgId, userId, count: rows.length, unreadCount },
        "notifications.list: ok",
      );
      return {
        notifications: rows.map((r) => ({
          id: r.id,
          publicId: r.publicId,
          kind: r.kind,
          title: r.title,
          body: r.body,
          deepLink: r.deepLink,
          unread: r.unread,
          archived: r.archived,
          createdAt: r.createdAt.toISOString(),
        })),
        unreadCount,
      };
    });
  } catch (err) {
    logger.error({ err, orgId, userId }, "notifications.list: failed");
    throw err;
  }
};
