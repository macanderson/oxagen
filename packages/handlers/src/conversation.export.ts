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
import { eq, sql } from "drizzle-orm";
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

import {
  exportLimitError,
  MAX_EXPORT_HEADER_BYTES,
  MAX_EXPORT_MARKDOWN_BYTES,
  MAX_EXPORT_MESSAGES,
} from "./lib/conversation-export-limits";
import {
  conversationExportSnapshotQuery,
  type ConversationExportSnapshot,
} from "./lib/conversation-export-snapshot";

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

  const convRows = await withTenantDb((tx) =>
    tx.execute<ConversationExportSnapshot>(
      conversationExportSnapshotQuery(
        input.conversationId,
        ctx.orgId,
        ctx.workspaceId,
      ),
    ),
  );
  const conv = convRows[0];
  if (!conv) {
    logger.warn(
      { orgId: ctx.orgId, conversationId: input.conversationId },
      "conversation.export: conversation not found or out of scope",
    );
    throw new Error("conversation.export: conversation not found");
  }

  if (conv.messageCount > MAX_EXPORT_MESSAGES) {
    throw exportLimitError("500 messages across all branches");
  }
  if (conv.sourceTooLarge) {
    throw exportLimitError(
      "2 MiB of message content and metadata across all branches",
    );
  }
  if (conv.titleTooLarge) throw exportLimitError("8 KiB of title text");
  if (conv.messages === null) {
    throw new Error("Conversation export snapshot is incomplete");
  }
  const rows = conv.messages.map((row) => ({
    ...row,
    createdAt: new Date(row.createdAt),
  }));

  // Resolve org + workspace display names for the export header (best-effort —
  // an export must not fail because a name lookup came back empty).
  const orgRows = await withTenantDb((tx) =>
    tx
      .select({
        name: sql<string | null>`case when octet_length(${schema.organizations.name}) <= ${MAX_EXPORT_HEADER_BYTES} then ${schema.organizations.name} else null end`,
        tooLarge: sql<boolean>`octet_length(${schema.organizations.name}) > ${MAX_EXPORT_HEADER_BYTES}`,
      })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, ctx.orgId))
      .limit(1),
  );
  const wsRows = await withTenantDb((tx) =>
    tx
      .select({
        name: sql<string | null>`case when octet_length(${schema.workspaces.name}) <= ${MAX_EXPORT_HEADER_BYTES} then ${schema.workspaces.name} else null end`,
        tooLarge: sql<boolean>`octet_length(${schema.workspaces.name}) > ${MAX_EXPORT_HEADER_BYTES}`,
      })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, ctx.workspaceId))
      .limit(1),
  );

  if (orgRows[0]?.tooLarge || wsRows[0]?.tooLarge) {
    throw exportLimitError("8 KiB of organization or workspace name text");
  }
  const branch = walkActiveBranch(rows, conv.activeLeafMessageId);
  const exportedAt = new Date();
  const title = conv.title?.trim() || UNTITLED;
  const model: ConversationExportModel = {
    title,
    createdAt: new Date(conv.createdAt),
    exportedAt,
    orgName: orgRows[0]?.name ?? null,
    workspaceName: wsRows[0]?.name ?? null,
    messages: branchToExportMessages(branch),
    totalMessageCount: rows.length,
  };

  if (input.format === "markdown") {
    const content = conversationToMarkdown(model);
    if (Buffer.byteLength(content, "utf8") > MAX_EXPORT_MARKDOWN_BYTES) {
      throw exportLimitError("4 MiB of Markdown");
    }
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
