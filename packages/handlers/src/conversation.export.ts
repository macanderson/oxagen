// conversation.export.ts — export a conversation's active branch as Markdown
// or a formatted PDF.
//
// Markdown is returned inline (no storage). PDF is rendered with pdf-lib and
// persisted as a PRIVATE generated asset (accessPolicy "user") that is
// deliberately NOT linked to the conversation — conversationId and messageId
// are passed as null so persistGeneratedAsset's resolveConversationId cannot
// pick a linkage up, keeping the export out of the Conversation Files panel.

import type { CapabilityHandler } from "@oxagen/oxagen";
import { conversationExport } from "@oxagen/oxagen/contracts/conversation.export";
import { schema, withTenantDb } from "@oxagen/database";
import { and, asc, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";
import {
  branchToExportMessages,
  conversationToMarkdown,
  exportFilename,
  walkActiveBranch,
  type ConversationExportModel,
} from "./lib/conversation-markdown";
import { buildConversationPdf } from "./lib/conversation-pdf";
import { persistGeneratedAsset } from "./generated-asset.persist";

const UNTITLED = "Untitled conversation";

export const conversationExportHandler: CapabilityHandler<
  typeof conversationExport
> = async (input, ctx) => {
  if (!ctx.userId) {
    logger.warn(
      { orgId: ctx.orgId },
      "conversation.export: rejected — no authenticated user",
    );
    throw new Error("conversation.export requires an authenticated user");
  }

  // Resolve the conversation row — must belong to the caller's org + workspace
  // (same tenant-scoped access pattern as conversation.files.list).
  const convRows = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.conversations.id,
        title: schema.conversations.title,
        createdAt: schema.conversations.createdAt,
        activeLeafMessageId: schema.conversations.activeLeafMessageId,
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
    logger.warn(
      { orgId: ctx.orgId, conversationId: input.conversationId },
      "conversation.export: conversation not found or out of scope",
    );
    throw new Error("conversation.export: conversation not found");
  }

  // Load every message row (all branches) in chronological order; the walk
  // below reduces them to the currently-active path.
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.messages.id,
        parentMessageId: schema.messages.parentMessageId,
        role: schema.messages.role,
        content: schema.messages.content,
        contentBlocks: schema.messages.contentBlocks,
        metadata: schema.messages.metadata,
        createdAt: schema.messages.createdAt,
      })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.conversationId, conv.id),
          eq(schema.messages.orgId, ctx.orgId),
          eq(schema.messages.workspaceId, ctx.workspaceId),
        ),
      )
      .orderBy(asc(schema.messages.createdAt)),
  );

  // Resolve org + workspace display names for the export header (best-effort —
  // an export must not fail because a name lookup came back empty).
  const orgRows = await withTenantDb((tx) =>
    tx
      .select({ name: schema.organizations.name })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, ctx.orgId))
      .limit(1),
  );
  const wsRows = await withTenantDb((tx) =>
    tx
      .select({ name: schema.workspaces.name })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, ctx.workspaceId))
      .limit(1),
  );

  const branch = walkActiveBranch(rows, conv.activeLeafMessageId);
  const exportedAt = new Date();
  const title = conv.title?.trim() || UNTITLED;
  const model: ConversationExportModel = {
    title,
    createdAt: conv.createdAt,
    exportedAt,
    orgName: orgRows[0]?.name ?? null,
    workspaceName: wsRows[0]?.name ?? null,
    messages: branchToExportMessages(branch),
    totalMessageCount: rows.length,
  };

  if (input.format === "markdown") {
    const content = conversationToMarkdown(model);
    const filename = exportFilename(title, exportedAt, "md");
    logger.info(
      {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        userId: ctx.userId,
        conversationId: input.conversationId,
        format: "markdown",
        messageCount: model.messages.length,
        surface: ctx.surface,
      },
      "conversation.export: markdown export complete",
    );
    return {
      format: "markdown" as const,
      filename,
      content,
      url: null,
      messageCount: model.messages.length,
    };
  }

  // ── PDF ────────────────────────────────────────────────────────────────────
  const bytes = await buildConversationPdf(model);
  const filename = exportFilename(title, exportedAt, "pdf");

  const asset = await persistGeneratedAsset({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    kind: "pdf",
    // Private to the requester — an export is a personal download, not a
    // shared conversation artifact.
    accessPolicy: "user",
    bytes,
    mimeType: "application/pdf",
    prompt: `Export conversation: ${title}`,
    model: "local",
    displayName: filename.replace(/\.pdf$/, ""),
    // Explicitly unlinked: the export must NOT appear as a conversation file.
    // Passing both as null keeps resolveConversationId from inferring a
    // linkage (never forward ctx.messageId here).
    conversationId: null,
    messageId: null,
  });

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      userId: ctx.userId,
      conversationId: input.conversationId,
      format: "pdf",
      publicId: asset.publicId,
      sizeBytes: asset.sizeBytes,
      messageCount: model.messages.length,
      surface: ctx.surface,
    },
    "conversation.export: pdf export complete",
  );

  return {
    format: "pdf" as const,
    filename,
    content: null,
    url: asset.serveUrl,
    messageCount: model.messages.length,
  };
};
