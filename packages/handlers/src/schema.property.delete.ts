import type { CapabilityHandler } from "@oxagen/oxagen";
import { schemaPropertyDelete } from "@oxagen/oxagen/contracts/schema.property.delete";
import { schema as db, withTenantDb } from "@oxagen/database";
import { eq, and, isNull } from "drizzle-orm";
import { getOrCreateRegistry } from "./schema.versioning";
import { logger } from "./logger";

export const schemaPropertyDeleteHandler: CapabilityHandler<
  typeof schemaPropertyDelete
> = async (input, ctx) => {
  const registry = await getOrCreateRegistry(
    ctx.orgId,
    ctx.workspaceId,
    ctx.userId,
  );

  if (!registry.draftVersionId) {
    return { deleted: false, propertyKey: input.key };
  }

  const deleted = await withTenantDb(async (tx) => {
    let internalOwnerId: string | null = null;
    let ownerColumn: "nodeLabelId" | "relationshipTypeId";

    if (input.ownerKind === "node") {
      const [label] = await tx
        .select()
        .from(db.nodeLabels)
        .where(
          and(
            eq(db.nodeLabels.versionId, registry.draftVersionId!),
            eq(db.nodeLabels.name, input.ownerName),
            isNull(db.nodeLabels.deletedAt),
          ),
        )
        .limit(1);
      if (!label) return false;
      internalOwnerId = label.id;
      ownerColumn = "nodeLabelId";
    } else {
      const [rel] = await tx
        .select()
        .from(db.relationshipTypes)
        .where(
          and(
            eq(db.relationshipTypes.versionId, registry.draftVersionId!),
            eq(db.relationshipTypes.name, input.ownerName),
            isNull(db.relationshipTypes.deletedAt),
          ),
        )
        .limit(1);
      if (!rel) return false;
      internalOwnerId = rel.id;
      ownerColumn = "relationshipTypeId";
    }

    const whereCondition =
      ownerColumn === "nodeLabelId"
        ? and(
            eq(db.schemaProperties.nodeLabelId, internalOwnerId!),
            eq(db.schemaProperties.key, input.key),
            isNull(db.schemaProperties.deletedAt),
          )
        : and(
            eq(db.schemaProperties.relationshipTypeId, internalOwnerId!),
            eq(db.schemaProperties.key, input.key),
            isNull(db.schemaProperties.deletedAt),
          );

    const [propRow] = await tx
      .select()
      .from(db.schemaProperties)
      .where(whereCondition)
      .limit(1);

    if (!propRow) return false;

    await tx
      .update(db.schemaProperties)
      .set({ deletedAt: new Date(), updatedByUserId: ctx.userId })
      .where(eq(db.schemaProperties.id, propRow.id));

    return true;
  });

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      ownerName: input.ownerName,
      key: input.key,
      deleted,
    },
    "schema.property.delete: soft-deleted property",
  );

  return { deleted, propertyKey: input.key };
};
