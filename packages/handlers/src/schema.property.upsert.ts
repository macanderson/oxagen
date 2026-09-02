import type { CapabilityHandler } from "@oxagen/oxagen";
import { schemaPropertyUpsert } from "@oxagen/oxagen/contracts/schema.property.upsert";
import { schema as db, withTenantDb } from "@oxagen/database";
import { eq, and, isNull } from "drizzle-orm";
import { getOrCreateRegistry } from "./schema.versioning";
import { logger } from "./logger";

export const schemaPropertyUpsertHandler: CapabilityHandler<
  typeof schemaPropertyUpsert
> = async (input, ctx) => {
  const registry = await getOrCreateRegistry(
    ctx.orgId,
    ctx.workspaceId,
    ctx.userId,
  );

  if (!registry.draftVersionId) {
    throw new Error("No draft version found for registry");
  }

  const result = await withTenantDb(async (tx) => {
    // Resolve the owner (node label or relationship type) within draft
    let nodeLabelId: string | null = null;
    let relationshipTypeId: string | null = null;

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
      if (!label)
        throw new Error(`Node label "${input.ownerName}" not found in draft`);
      nodeLabelId = label.id;
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
      if (!rel)
        throw new Error(
          `Relationship type "${input.ownerName}" not found in draft`,
        );
      relationshipTypeId = rel.id;
    }

    // Upsert the property
    const whereConditions =
      nodeLabelId !== null
        ? and(
            eq(db.schemaProperties.nodeLabelId, nodeLabelId),
            eq(db.schemaProperties.key, input.key),
            isNull(db.schemaProperties.deletedAt),
          )
        : and(
            eq(db.schemaProperties.relationshipTypeId, relationshipTypeId!),
            eq(db.schemaProperties.key, input.key),
            isNull(db.schemaProperties.deletedAt),
          );

    const [existing] = await tx
      .select()
      .from(db.schemaProperties)
      .where(whereConditions)
      .limit(1);

    if (existing) {
      const [updated] = await tx
        .update(db.schemaProperties)
        .set({
          dataType: input.dataType,
          required: input.required,
          description: input.description ?? existing.description,
          enumValues: input.enumValues ?? existing.enumValues,
          itemType: input.itemType ?? existing.itemType,
          constraints: input.constraints ?? existing.constraints,
          example: input.example ?? existing.example,
          updatedByUserId: ctx.userId,
        })
        .where(eq(db.schemaProperties.id, existing.id))
        .returning();

      return {
        propertyId: updated?.publicId ?? existing.publicId,
        created: false,
      };
    }

    const [inserted] = await tx
      .insert(db.schemaProperties)
      .values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        versionId: registry.draftVersionId!,
        nodeLabelId,
        relationshipTypeId,
        key: input.key,
        dataType: input.dataType,
        required: input.required,
        description: input.description,
        enumValues: input.enumValues,
        itemType: input.itemType,
        constraints: input.constraints ?? {},
        example: input.example,
        createdByUserId: ctx.userId,
        updatedByUserId: ctx.userId,
      })
      .returning();

    if (!inserted) throw new Error(`Failed to insert property ${input.key}`);

    return { propertyId: inserted.publicId, created: true };
  });

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      ownerName: input.ownerName,
      key: input.key,
      created: result.created,
    },
    "schema.property.upsert: upserted property",
  );

  return result;
};
