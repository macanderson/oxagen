import type { CapabilityHandler } from "@oxagen/oxagen";
import { documentRead } from "@oxagen/oxagen/contracts/document.read";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";

export const documentReadHandler: CapabilityHandler<
  typeof documentRead
> = async (input, ctx) => {
  if (!ctx.workspaceId) {
    logger.warn(
      { orgId: ctx.orgId },
      "document.read: rejected — no workspace scope",
    );
    throw new Error("document.read requires a workspace scope");
  }

  const rows = await withTenantDb((tx) =>
    tx
      .select({
        title: schema.documents.title,
        content: schema.documents.content,
        metadata: schema.documents.metadata,
        createdAt: schema.documents.createdAt,
      })
      .from(schema.documents)
      .where(
        and(
          eq(schema.documents.publicId, input.document_id),
          eq(schema.documents.workspaceId, ctx.workspaceId!),
          isNull(schema.documents.deletedAt),
        ),
      )
      .limit(1),
  );

  const row = rows[0];
  if (!row) {
    logger.warn(
      {
        documentId: input.document_id,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
      },
      "document.read: document not found",
    );
    throw new Error(`document.read: document "${input.document_id}" not found`);
  }

  logger.info(
    {
      documentId: input.document_id,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    },
    "document.read: returned document",
  );

  return {
    title: row.title,
    content: row.content,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    created_at: row.createdAt.toISOString(),
  };
};
