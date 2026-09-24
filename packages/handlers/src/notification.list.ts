import { and, eq, count, sql, isNull } from "drizzle-orm";
import { schema, withTenantDb, withOrgDb } from "@oxagen/database";
import type { CapabilityHandlerFn } from "@oxagen/oxagen/kernel";
import { ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen/types";
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
    const orgOnly =
      !ctx.workspaceId || ctx.workspaceId === ORG_ONLY_WORKSPACE_ID;
    const workspaceFilter = orgOnly
      ? isNull(schema.notifications.workspaceId)
      : undefined;
    const readDb = orgOnly ? withOrgDb : withTenantDb;
    return await readDb(async (tx) => {
      const conditions = [
        eq(schema.notifications.userId, userId),
        eq(schema.notifications.orgId, orgId),
        eq(schema.notifications.archived, false),
        workspaceFilter,
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
            event: schema.notifications.event,
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
              workspaceFilter,
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
          event: r.event,
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
