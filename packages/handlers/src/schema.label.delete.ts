import type { CapabilityHandler } from "@oxagen/oxagen";
import { schemaLabelDelete } from "@oxagen/oxagen/contracts/schema.label.delete";
import { schema as db, withTenantDb } from "@oxagen/database";
import { eq, and, isNull } from "drizzle-orm";
import { getOrCreateRegistry } from "./schema.versioning";
import { logger } from "./logger";

export const schemaLabelDeleteHandler: CapabilityHandler<
  typeof schemaLabelDelete
> = async (input, ctx) => {
  const registry = await getOrCreateRegistry(
    ctx.orgId,
    ctx.workspaceId,
    ctx.userId,
  );

  if (!registry.draftVersionId) {
    return { deleted: false, labelName: input.name };
  }

  const deleted = await withTenantDb(async (tx) => {
    // Find schema in draft
    const [schemaRow] = await tx
      .select()
      .from(db.schemas)
      .where(
        and(
          eq(db.schemas.versionId, registry.draftVersionId!),
          eq(db.schemas.name, input.schemaName),
          isNull(db.schemas.deletedAt),
        ),
      )
      .limit(1);

    if (!schemaRow) return false;

    // Find label
    const [labelRow] = await tx
      .select()
      .from(db.nodeLabels)
      .where(
        and(
          eq(db.nodeLabels.versionId, registry.draftVersionId!),
          eq(db.nodeLabels.schemaId, schemaRow.id),
          eq(db.nodeLabels.name, input.name),
          isNull(db.nodeLabels.deletedAt),
        ),
      )
      .limit(1);

    if (!labelRow) return false;

    const now = new Date();

    // Soft-delete properties owned by this label
    await tx
      .update(db.schemaProperties)
      .set({ deletedAt: now, updatedByUserId: ctx.userId })
      .where(
        and(
          eq(db.schemaProperties.nodeLabelId, labelRow.id),
          isNull(db.schemaProperties.deletedAt),
        ),
      );

    // Soft-delete label
    await tx
      .update(db.nodeLabels)
      .set({ deletedAt: now, updatedByUserId: ctx.userId })
      .where(eq(db.nodeLabels.id, labelRow.id));

    return true;
  });

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      label: input.name,
      deleted,
    },
    "schema.label.delete: soft-deleted label",
  );

  return { deleted, labelName: input.name };
};
