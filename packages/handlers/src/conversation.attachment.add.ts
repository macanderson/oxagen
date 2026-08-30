import type { CapabilityHandler } from "@oxagen/oxagen";
import { conversationAttachmentAdd } from "@oxagen/oxagen/contracts/conversation.attachment.add";
import type { ConversationAssetKind } from "@oxagen/oxagen/contracts/conversation.files.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";
import { assetDisplayName } from "./lib/asset-filename";
import { metadataDisplayName } from "./conversation.files.list";

// Link an already-stored asset (typically the output of asset.upload with
// source="user_upload") to a conversation. This is the second half of the
// "attach a file to chat" flow: upload the bytes once, then point the asset
// row's conversation_id at the target conversation so it appears in
// conversation.files.list / the message thread.
//
// Four-store law: this handler moves NO bytes — the asset already lives in
// blob storage and is referenced by its generated_assets row. We only update
// the conversation linkage column and return the row's conversationAssetItem.
export const conversationAttachmentAddHandler: CapabilityHandler<
  typeof conversationAttachmentAdd
> = async (input, ctx) => {
  if (!ctx.userId) {
    logger.warn(
      { orgId: ctx.orgId },
      "conversation.attachment.add: rejected — no authenticated user",
    );
    throw new Error(
      "conversation.attachment.add requires an authenticated user",
    );
  }

  // Resolve the conversation — must belong to the caller's org + workspace.
  const convRows = await withTenantDb((tx) =>
    tx
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.publicId, input.conversationId),
          eq(schema.conversations.orgId, ctx.orgId),
          eq(schema.conversations.workspaceId, ctx.workspaceId),
          isNull(schema.conversations.deletedAt),
        ),
      )
      .limit(1),
  );
  const conv = convRows[0];
  if (!conv) {
    logger.warn(
      { orgId: ctx.orgId, conversationId: input.conversationId },
      "conversation.attachment.add: conversation not found or out of scope",
    );
    throw new Error("conversation.attachment.add: conversation not found");
  }

  // Resolve the asset — must belong to the caller's org + workspace, be
  // ready, and (for the `user` access policy) be owned by the caller. This
  // is the same visibility contract conversation.files.list enforces.
  const assetRows = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.generatedAssets.id,
        publicId: schema.generatedAssets.publicId,
        kind: schema.generatedAssets.kind,
        mimeType: schema.generatedAssets.mimeType,
        sizeBytes: schema.generatedAssets.sizeBytes,
        status: schema.generatedAssets.status,
        accessPolicy: schema.generatedAssets.accessPolicy,
        userId: schema.generatedAssets.userId,
        prompt: schema.generatedAssets.prompt,
        metadata: schema.generatedAssets.metadata,
        createdAt: schema.generatedAssets.createdAt,
      })
      .from(schema.generatedAssets)
      .where(
        and(
          eq(schema.generatedAssets.publicId, input.assetPublicId),
          eq(schema.generatedAssets.orgId, ctx.orgId),
          eq(schema.generatedAssets.workspaceId, ctx.workspaceId),
          isNull(schema.generatedAssets.deletedAt),
        ),
      )
      .limit(1),
  );
  const asset = assetRows[0];
  if (!asset) {
    logger.warn(
      { orgId: ctx.orgId, assetPublicId: input.assetPublicId },
      "conversation.attachment.add: asset not found or out of scope",
    );
    throw new Error("conversation.attachment.add: asset not found");
  }
  if (asset.status !== "ready") {
    throw new Error(
      `conversation.attachment.add: asset is not ready (status: ${asset.status})`,
    );
  }
  // A `user`-private asset can only be attached by its owner.
  if (asset.accessPolicy === "user" && asset.userId !== ctx.userId) {
    logger.warn(
      {
        orgId: ctx.orgId,
        assetPublicId: input.assetPublicId,
        userId: ctx.userId,
      },
      "conversation.attachment.add: asset not owned by caller",
    );
    throw new Error("conversation.attachment.add: asset not found");
  }

  // Link the asset to the conversation. Idempotent: re-attaching the same
  // asset to the same conversation is a no-op that still returns the record.
  await withTenantDb((tx) =>
    tx
      .update(schema.generatedAssets)
      .set({ conversationId: conv.id, updatedByUserId: ctx.userId })
      .where(
        and(
          eq(schema.generatedAssets.id, asset.id),
          eq(schema.generatedAssets.orgId, ctx.orgId),
          eq(schema.generatedAssets.workspaceId, ctx.workspaceId),
        ),
      ),
  );

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      conversationId: input.conversationId,
      assetPublicId: input.assetPublicId,
      surface: ctx.surface,
    },
    "conversation.attachment.add: linked asset to conversation",
  );

  return {
    publicId: asset.publicId,
    kind: asset.kind as ConversationAssetKind,
    name: assetDisplayName({
      prompt: asset.prompt,
      kind: asset.kind,
      mimeType: asset.mimeType,
      publicId: asset.publicId,
      displayName: metadataDisplayName(asset.metadata),
    }),
    mimeType: asset.mimeType,
    sizeBytes: asset.sizeBytes !== null ? Number(asset.sizeBytes) : null,
    status: asset.status,
    accessPolicy: asset.accessPolicy as "user" | "org" | "public",
    createdAt: asset.createdAt.toISOString(),
    url: `/api/v1/assets/${asset.publicId}`,
  };
};
