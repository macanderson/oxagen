import type { CapabilityHandler } from "@oxagen/oxagen";
import { conversationArchive } from "@oxagen/oxagen/contracts/conversation.archive";
import { db, schema } from "@oxagen/database";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { logger } from "./logger";

export const conversationArchiveHandler: CapabilityHandler<typeof conversationArchive> = async (
  input,
  ctx,
) => {
  if (!ctx.userId) {
    logger.warn({ orgId: ctx.orgId }, "conversation.archive: rejected — no authenticated user");
    throw new Error("conversation.archive requires an authenticated user");
  }

  const d = db();
  const now = new Date();

  const rows = await d
    .update(schema.conversations)
    .set({
      archivedAt: input.archived ? now : null,
      archivedByUserId: input.archived ? ctx.userId : null,
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
      archived: input.archived,
      updated: rows.length,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      surface: ctx.surface,
    },
    "conversation.archive: updated conversations",
  );

  return { updated: rows.length };
};
