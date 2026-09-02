import type { CapabilityHandler } from "@oxagen/oxagen";
import { schemaDelete } from "@oxagen/oxagen/contracts/schema.delete";
import { schema as db, withTenantDb } from "@oxagen/database";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { getOrCreateRegistry } from "./schema.versioning";
import { logger } from "./logger";

export const schemaDeleteHandler: CapabilityHandler<
  typeof schemaDelete
> = async (input, ctx) => {
  const registry = await getOrCreateRegistry(
    ctx.orgId,
    ctx.workspaceId,
    ctx.userId,
  );

  if (!registry.draftVersionId) {
    return {
      deleted: false,
      schemaName: input.schemaName,
      labelsRemoved: 0,
      relationshipTypesRemoved: 0,
    };
  }

  const result = await withTenantDb(async (tx) => {
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

    if (!schemaRow)
      return { deleted: false, labelsRemoved: 0, relationshipTypesRemoved: 0 };

    const now = new Date();

    const labels = await tx
      .select({ id: db.nodeLabels.id })
      .from(db.nodeLabels)
      .where(
        and(
          eq(db.nodeLabels.schemaId, schemaRow.id),
          isNull(db.nodeLabels.deletedAt),
        ),
      );
    const rels = await tx
      .select({ id: db.relationshipTypes.id })
      .from(db.relationshipTypes)
      .where(
        and(
          eq(db.relationshipTypes.schemaId, schemaRow.id),
          isNull(db.relationshipTypes.deletedAt),
        ),
      );

    const labelIds = labels.map((l) => l.id);
    const relIds = rels.map((r) => r.id);

    // Soft-delete every property owned by this schema's labels/relationship types.
    if (labelIds.length) {
      await tx
        .update(db.schemaProperties)
        .set({ deletedAt: now, updatedByUserId: ctx.userId })
        .where(
          and(
            inArray(db.schemaProperties.nodeLabelId, labelIds),
            isNull(db.schemaProperties.deletedAt),
          ),
        );
    }
    if (relIds.length) {
      await tx
        .update(db.schemaProperties)
        .set({ deletedAt: now, updatedByUserId: ctx.userId })
        .where(
          and(
            inArray(db.schemaProperties.relationshipTypeId, relIds),
            isNull(db.schemaProperties.deletedAt),
          ),
        );
    }

    if (labelIds.length) {
      await tx
        .update(db.nodeLabels)
        .set({ deletedAt: now, updatedByUserId: ctx.userId })
        .where(inArray(db.nodeLabels.id, labelIds));
    }
    if (relIds.length) {
      await tx
        .update(db.relationshipTypes)
        .set({ deletedAt: now, updatedByUserId: ctx.userId })
        .where(inArray(db.relationshipTypes.id, relIds));
    }

    await tx
      .update(db.schemas)
      .set({ deletedAt: now, updatedByUserId: ctx.userId })
      .where(eq(db.schemas.id, schemaRow.id));

    return {
      deleted: true,
      labelsRemoved: labelIds.length,
      relationshipTypesRemoved: relIds.length,
    };
  });

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      schemaName: input.schemaName,
      ...result,
    },
    "schema.delete: dropped schema",
  );

  return {
    deleted: result.deleted,
    schemaName: input.schemaName,
    labelsRemoved: result.labelsRemoved,
    relationshipTypesRemoved: result.relationshipTypesRemoved,
  };
};
