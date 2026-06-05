import type { CapabilityHandler } from "@oxagen/oxagen";
import { conversationDelete } from "@oxagen/oxagen/contracts/conversation.delete";
import { db, schema } from "@oxagen/database";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { logger } from "./logger";

export const conversationDeleteHandler: CapabilityHandler<typeof conversationDelete> = async (
  input,
  ctx,
) => {
  if (!ctx.userId) {
    logger.warn({ orgId: ctx.orgId }, "conversation.delete: rejected — no authenticated user");
    throw new Error("conversation.delete requires an authenticated user");
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
        inArray(schema.conversations.publicId, input.conversationIds),
        eq(schema.conversations.orgId, ctx.orgId),
        eq(schema.conversations.workspaceId, ctx.workspaceId),
        eq(schema.conversations.userId, ctx.userId),
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
    "conversation.delete: soft-deleted conversations",
  );

  return { deleted: rows.length };
};
