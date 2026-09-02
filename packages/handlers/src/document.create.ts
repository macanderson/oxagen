import type { CapabilityHandler } from "@oxagen/oxagen";
import { documentCreate } from "@oxagen/oxagen/contracts/document.create";
import { schema, withTenantDb } from "@oxagen/database";
import { logger } from "./logger";

export const documentCreateHandler: CapabilityHandler<
  typeof documentCreate
> = async (input, ctx) => {
  if (!ctx.workspaceId) {
    logger.warn(
      { orgId: ctx.orgId },
      "document.create: rejected — no workspace scope",
    );
    throw new Error("document.create requires a workspace scope");
  }
  if (!ctx.userId) {
    logger.warn(
      { orgId: ctx.orgId },
      "document.create: rejected — no authenticated user",
    );
    throw new Error("document.create requires an authenticated user");
  }

  const [row] = await withTenantDb((tx) =>
    tx
      .insert(schema.documents)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId!,
        title: input.title,
        content: input.content ?? "",
        createdByUserId: ctx.userId!,
        updatedByUserId: ctx.userId!,
      })
      .returning({
        publicId: schema.documents.publicId,
        title: schema.documents.title,
        createdAt: schema.documents.createdAt,
      }),
  );

  if (!row) throw new Error("document.create: insert returned no row");

  logger.info(
    { publicId: row.publicId, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    "document.create: inserted document",
  );

  return {
    document_id: row.publicId,
    title: row.title,
    created_at: row.createdAt.toISOString(),
    workspace_id: ctx.workspaceId,
  };
};
