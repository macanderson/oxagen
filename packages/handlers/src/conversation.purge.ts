import type { CapabilityHandler } from "@oxagen/oxagen";
import { conversationPurge } from "@oxagen/oxagen/contracts/conversation.purge";
import { db, schema } from "@oxagen/database";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { logger } from "./logger";

export const conversationPurgeHandler: CapabilityHandler<typeof conversationPurge> = async (
  _input,
  ctx,
) => {
  if (!ctx.userId) {
    logger.warn({ orgId: ctx.orgId }, "conversation.purge: rejected — no authenticated user");
    throw new Error("conversation.purge requires an authenticated user");
  }

  const d = db();
  const now = new Date();

  const rows = await d
    .update(schema.conversations)
    .set({
      deletedAt: now,
      deletedByUserId: ctx.userId,
      updatedAt: now,
      updatedByUserId: ctx.userId,
    })
    .where(
      and(
        eq(schema.conversations.orgId, ctx.orgId),
        eq(schema.conversations.workspaceId, ctx.workspaceId),
        eq(schema.conversations.userId, ctx.userId),
        isNotNull(schema.conversations.archivedAt),
        isNull(schema.conversations.deletedAt),
      ),
    )
    .returning({ publicId: schema.conversations.publicId });

  logger.info(
    {
      deleted: rows.length,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      surface: ctx.surface,
    },
    "conversation.purge: soft-deleted all archived conversations",
  );

  return { deleted: rows.length };
};
