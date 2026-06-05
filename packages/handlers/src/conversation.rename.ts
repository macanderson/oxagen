import type { CapabilityHandler } from "@oxagen/oxagen";
import { conversationRename } from "@oxagen/oxagen/contracts/conversation.rename";
import { db, schema } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";

export const conversationRenameHandler: CapabilityHandler<typeof conversationRename> = async (
  input,
  ctx,
) => {
  if (!ctx.userId) {
    logger.warn({ orgId: ctx.orgId }, "conversation.rename: rejected — no authenticated user");
    throw new Error("conversation.rename requires an authenticated user");
  }

  const d = db();
  const now = new Date();

  const rows = await d
    .update(schema.conversations)
    .set({
      title: input.title,
      updatedAt: now,
      updatedByUserId: ctx.userId,
    })
    .where(
      and(
        eq(schema.conversations.publicId, input.conversationId),
        eq(schema.conversations.orgId, ctx.orgId),
        eq(schema.conversations.workspaceId, ctx.workspaceId),
        eq(schema.conversations.userId, ctx.userId),
        isNull(schema.conversations.deletedAt),
      ),
    )
    .returning({
      publicId: schema.conversations.publicId,
      title: schema.conversations.title,
    });

  if (rows.length === 0) {
    logger.warn(
      {
        conversationId: input.conversationId,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
      },
      "conversation.rename: conversation not found",
    );
    throw new Error("conversation.rename: conversation not found");
  }

  const row = rows[0]!;

  logger.info(
    {
      publicId: row.publicId,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      surface: ctx.surface,
    },
    "conversation.rename: renamed successfully",
  );

  return {
    publicId: row.publicId,
    title: row.title!,
  };
};
