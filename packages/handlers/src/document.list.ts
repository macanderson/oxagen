import type { CapabilityHandler } from "@oxagen/oxagen";
import { documentList } from "@oxagen/oxagen/contracts/document.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, desc, eq, isNull } from "drizzle-orm";
import { logger } from "./logger";

export const documentListHandler: CapabilityHandler<
  typeof documentList
> = async (input, ctx) => {
  if (!ctx.workspaceId) {
    logger.warn(
      { orgId: ctx.orgId },
      "document.list: rejected — no workspace scope",
    );
    throw new Error("document.list requires a workspace scope");
  }

  // input.workspace_id is optional and informational; the tenanted db scope
  // is already established by the kernel — always filter by ctx.workspaceId.
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.documents.publicId,
        title: schema.documents.title,
        createdAt: schema.documents.createdAt,
        updatedAt: schema.documents.updatedAt,
        createdByUserId: schema.documents.createdByUserId,
      })
      .from(schema.documents)
      .where(
        and(
          eq(schema.documents.workspaceId, ctx.workspaceId!),
          isNull(schema.documents.deletedAt),
        ),
      )
      .orderBy(desc(schema.documents.createdAt)),
  );

  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, count: rows.length },
    "document.list: returned documents",
  );

  return {
    documents: rows.map((row) => ({
      id: row.publicId,
      title: row.title,
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
      // author is the userId of the creator; no cross-schema join needed since
      // the contract specifies a string (not a resolved display name).
      author: row.createdByUserId ?? "unknown",
    })),
  };
};
