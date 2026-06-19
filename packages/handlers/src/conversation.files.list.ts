import type { CapabilityHandler } from "@oxagen/oxagen";
import { conversationFilesList } from "@oxagen/oxagen/contracts/conversation.files.list";
import type { ConversationAssetKind } from "@oxagen/oxagen/contracts/conversation.files.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
import { logger } from "./logger";

// All asset kinds supported by generated_assets_kind_check.
const ALL_KINDS: ConversationAssetKind[] = [
  "image",
  "video",
  "document",
  "spreadsheet",
  "presentation",
  "pdf",
  "archive",
];

/**
 * Derive a human-readable display name for a generated asset.
 * Uses the first sentence of the generation prompt (≤60 chars) with a
 * kind-specific extension suffix. Falls back to "<kind>-<publicId-suffix>".
 */
function deriveAssetName(
  kind: string,
  prompt: string,
  publicId: string,
): string {
  if (prompt.trim().length > 0) {
    const sentence = prompt.split(/[.!?\n]/)[0]?.trim() ?? prompt;
    const label = sentence.length > 60 ? `${sentence.slice(0, 57)}…` : sentence;
    if (label.length > 0) {
      const ext = kindExtension(kind);
      return ext ? `${label}${ext}` : label;
    }
  }
  return `${kind}-${publicId.slice(-8)}`;
}

function kindExtension(kind: string): string {
  switch (kind) {
    case "pdf": return ".pdf";
    case "document": return ".docx";
    case "spreadsheet": return ".xlsx";
    case "presentation": return ".pptx";
    case "archive": return ".zip";
    default: return "";
  }
}

export const conversationFilesListHandler: CapabilityHandler<
  typeof conversationFilesList
> = async (input, ctx) => {
  if (!ctx.userId) {
    logger.warn(
      { orgId: ctx.orgId },
      "conversation.files.list: rejected — no authenticated user",
    );
    throw new Error("conversation.files.list requires an authenticated user");
  }

  // Resolve the conversation row — must belong to the caller's org.
  const convRows = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.conversations.id,
        orgId: schema.conversations.orgId,
        userId: schema.conversations.userId,
      })
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
    // Return 404-equivalent via a domain error. Callers should treat the empty
    // result + this throw as "conversation not found or not in scope".
    logger.warn(
      { orgId: ctx.orgId, conversationId: input.conversationId },
      "conversation.files.list: conversation not found or out of scope",
    );
    throw new Error("conversation.files.list: conversation not found");
  }

  // Build asset query conditions.
  const kinds = input.kind != null ? [input.kind] : ALL_KINDS;

  const assetConditions = [
    eq(schema.generatedAssets.conversationId, conv.id),
    isNull(schema.generatedAssets.deletedAt),
    eq(schema.generatedAssets.status, "ready"),
    inArray(schema.generatedAssets.kind, kinds),
  ];

  // Keyset cursor: createdAt < cursor (descending order).
  if (input.cursor) {
    assetConditions.push(
      lt(schema.generatedAssets.createdAt, new Date(input.cursor)),
    );
  }

  const fetchLimit = input.limit + 1;

  const assets = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.generatedAssets.publicId,
        kind: schema.generatedAssets.kind,
        mimeType: schema.generatedAssets.mimeType,
        sizeBytes: schema.generatedAssets.sizeBytes,
        status: schema.generatedAssets.status,
        accessPolicy: schema.generatedAssets.accessPolicy,
        userId: schema.generatedAssets.userId,
        prompt: schema.generatedAssets.prompt,
        createdAt: schema.generatedAssets.createdAt,
      })
      .from(schema.generatedAssets)
      .where(and(...assetConditions))
      .orderBy(desc(schema.generatedAssets.createdAt))
      .limit(fetchLimit),
  );

  // Access-policy filter applied in-process (after the indexed DB scan):
  //   user   → visible only to the asset's creator
  //   org    → visible to any org member (already verified via orgId scope above)
  //   public → visible to everyone
  const userId = ctx.userId;
  const visible = assets.filter(
    (a) => a.accessPolicy !== "user" || a.userId === userId,
  );

  // Pagination: slice to input.limit and derive the next cursor.
  let nextCursor: string | null = null;
  let page = visible;

  if (visible.length > input.limit) {
    nextCursor = visible[input.limit - 1]!.createdAt.toISOString();
    page = visible.slice(0, input.limit);
  }

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      conversationId: input.conversationId,
      kind: input.kind,
      count: page.length,
      hasNextPage: nextCursor !== null,
      surface: ctx.surface,
    },
    "conversation.files.list: returned files",
  );

  return {
    files: page.map((a) => ({
      publicId: a.publicId,
      kind: a.kind as ConversationAssetKind,
      name: deriveAssetName(a.kind, a.prompt, a.publicId),
      mimeType: a.mimeType,
      sizeBytes: a.sizeBytes !== null ? Number(a.sizeBytes) : null,
      status: a.status,
      accessPolicy: a.accessPolicy as "user" | "org" | "public",
      createdAt: a.createdAt.toISOString(),
      url: `/api/v1/assets/${a.publicId}`,
    })),
    nextCursor,
  };
};
