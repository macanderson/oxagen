import type { CapabilityHandler } from "@oxagen/oxagen";
import { conversationArchive } from "@oxagen/oxagen/contracts/conversation.archive";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { logger } from "./logger";

export const conversationArchiveHandler: CapabilityHandler<
  typeof conversationArchive
> = async (input, ctx) => {
  if (!ctx.userId) {
    logger.warn(
      { orgId: ctx.orgId },
      "conversation.archive: rejected — no authenticated user",
    );
    throw new Error("conversation.archive requires an authenticated user");
  }

  const userId = ctx.userId;
  const now = new Date();

  const rows = await withTenantDb((tx) =>
    tx
      .update(schema.conversations)
      .set({
        archivedAt: input.archived ? now : null,
        archivedByUserId: input.archived ? userId : null,
        updatedAt: now,
        updatedByUserId: userId,
      })
      .where(
        and(
          inArray(schema.conversations.publicId, input.conversationIds),
          eq(schema.conversations.orgId, ctx.orgId),
          eq(schema.conversations.workspaceId, ctx.workspaceId),
          eq(schema.conversations.userId, userId),
          isNull(schema.conversations.deletedAt),
        ),
      )
      .returning({ publicId: schema.conversations.publicId }),
  );

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
