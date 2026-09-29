// conversation.delete.ts: `delete_conversation`, a soft delete of the caller's
// own conversations. A conversation that is not the caller's, or is already
// deleted, is left alone and not counted.
//
// The files sent in a deleted conversation go with it (#4690). In the same
// transaction, every `generated_assets` row linked to a conversation this call
// deleted is soft-deleted too, so the attachment read route
// (serveGeneratedAsset) refuses it from then on. The match uses the internal
// ids the conversation update returned, so a conversation the call did not
// delete keeps its files.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { conversationDelete } from "@oxagen/oxagen/contracts/conversation.delete";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { logger } from "./logger";

export const conversationDeleteHandler: CapabilityHandler<
  typeof conversationDelete
> = async (input, ctx) => {
  if (!ctx.userId) {
    logger.warn(
      { orgId: ctx.orgId },
      "conversation.delete: rejected — no authenticated user",
    );
    throw new Error("conversation.delete requires an authenticated user");
  }

  const userId = ctx.userId;
  const now = new Date();
  const deletedBy = {
    deletedAt: now,
    deletedById: userId,
    updatedAt: now,
    updatedById: userId,
  };

  const { deleted, filesDeleted } = await withTenantDb(async (tx) => {
    const rows = await tx
      .update(schema.conversations)
      .set(deletedBy)
      .where(
        and(
          inArray(schema.conversations.publicId, input.conversationIds),
          eq(schema.conversations.orgId, ctx.orgId),
          eq(schema.conversations.workspaceId, ctx.workspaceId),
          eq(schema.conversations.userId, userId),
          isNull(schema.conversations.deletedAt),
        ),
      )
      .returning({
        id: schema.conversations.id,
        publicId: schema.conversations.publicId,
      });
    if (rows.length === 0) return { deleted: 0, filesDeleted: 0 };
    const files = await tx
      .update(schema.generatedAssets)
      .set(deletedBy)
      .where(
        and(
          inArray(
            schema.generatedAssets.conversationId,
            rows.map((row) => row.id),
          ),
          eq(schema.generatedAssets.orgId, ctx.orgId),
          eq(schema.generatedAssets.workspaceId, ctx.workspaceId),
          isNull(schema.generatedAssets.deletedAt),
        ),
      )
      .returning({ id: schema.generatedAssets.id });
    return { deleted: rows.length, filesDeleted: files.length };
  });

  logger.info(
    {
      deleted,
      filesDeleted,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      surface: ctx.surface,
    },
    "conversation.delete: soft-deleted conversations and their files",
  );

  return { deleted };
};
