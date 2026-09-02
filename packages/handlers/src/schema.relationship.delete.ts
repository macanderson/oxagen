import type { CapabilityHandler } from "@oxagen/oxagen";
import { schemaRelationshipDelete } from "@oxagen/oxagen/contracts/schema.relationship.delete";
import { schema as db, withTenantDb } from "@oxagen/database";
import { eq, and, isNull } from "drizzle-orm";
import { getOrCreateRegistry } from "./schema.versioning";
import { logger } from "./logger";

export const schemaRelationshipDeleteHandler: CapabilityHandler<
  typeof schemaRelationshipDelete
> = async (input, ctx) => {
  const registry = await getOrCreateRegistry(
    ctx.orgId,
    ctx.workspaceId,
    ctx.userId,
  );

  if (!registry.draftVersionId) {
    return { deleted: false, relationshipTypeName: input.name };
  }

  const deleted = await withTenantDb(async (tx) => {
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

    const [relRow] = await tx
      .select()
      .from(db.relationshipTypes)
      .where(
        and(
          eq(db.relationshipTypes.versionId, registry.draftVersionId!),
          eq(db.relationshipTypes.schemaId, schemaRow.id),
          eq(db.relationshipTypes.name, input.name),
          isNull(db.relationshipTypes.deletedAt),
        ),
      )
      .limit(1);

    if (!relRow) return false;

    const now = new Date();

    // Soft-delete properties owned by this relationship type
    await tx
      .update(db.schemaProperties)
      .set({ deletedAt: now, updatedByUserId: ctx.userId })
      .where(
        and(
          eq(db.schemaProperties.relationshipTypeId, relRow.id),
          isNull(db.schemaProperties.deletedAt),
        ),
      );

    // Soft-delete the relationship type
    await tx
      .update(db.relationshipTypes)
      .set({ deletedAt: now, updatedByUserId: ctx.userId })
      .where(eq(db.relationshipTypes.id, relRow.id));

    return true;
  });

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      name: input.name,
      deleted,
    },
    "schema.relationship.delete: soft-deleted relationship type",
  );

  return { deleted, relationshipTypeName: input.name };
};
