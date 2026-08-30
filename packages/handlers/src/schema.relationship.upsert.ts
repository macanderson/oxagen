import type { CapabilityHandler } from "@oxagen/oxagen";
import { schemaRelationshipUpsert } from "@oxagen/oxagen/contracts/schema.relationship.upsert";
import { schema as db, withTenantDb } from "@oxagen/database";
import { eq, and, isNull } from "drizzle-orm";
import {
  getOrCreateRegistry,
  getOrCreateDraftSchema,
} from "./schema.versioning";
import { logger } from "./logger";

export const schemaRelationshipUpsertHandler: CapabilityHandler<
  typeof schemaRelationshipUpsert
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
    const { schema: schemaRow } = await getOrCreateDraftSchema(
      ctx.orgId,
      ctx.workspaceId,
      registry.draftVersionId!,
      input.schemaName,
      ctx.userId,
      tx,
    );

    // Upsert relationship type (identity: name within version+schema)
    const [existing] = await tx
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

    let relationshipTypeId: string;
    let created: boolean;
    let internalRelId: string;

    if (existing) {
      const [updated] = await tx
        .update(db.relationshipTypes)
        .set({
          displayName: input.displayName,
          description: input.description ?? existing.description,
          startLabel: input.startLabel ?? existing.startLabel,
          endLabel: input.endLabel ?? existing.endLabel,
          cardinality: input.cardinality ?? existing.cardinality,
          updatedByUserId: ctx.userId,
        })
        .where(eq(db.relationshipTypes.id, existing.id))
        .returning();
      relationshipTypeId = updated?.publicId ?? existing.publicId;
      internalRelId = existing.id;
      created = false;
    } else {
      const [inserted] = await tx
        .insert(db.relationshipTypes)
        .values({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          versionId: registry.draftVersionId!,
          schemaId: schemaRow.id,
          name: input.name,
          displayName: input.displayName,
          description: input.description,
          startLabel: input.startLabel,
          endLabel: input.endLabel,
          cardinality: input.cardinality,
          createdByUserId: ctx.userId,
          updatedByUserId: ctx.userId,
        })
        .returning();
      if (!inserted)
        throw new Error(`Failed to insert relationship type ${input.name}`);
      relationshipTypeId = inserted.publicId;
      internalRelId = inserted.id;
      created = true;
    }

    // Upsert properties if provided
    if (input.properties && input.properties.length > 0) {
      for (const prop of input.properties) {
        const [existingProp] = await tx
          .select()
          .from(db.schemaProperties)
          .where(
            and(
              eq(db.schemaProperties.relationshipTypeId, internalRelId),
              eq(db.schemaProperties.key, prop.key),
              isNull(db.schemaProperties.deletedAt),
            ),
          )
          .limit(1);

        if (existingProp) {
          await tx
            .update(db.schemaProperties)
            .set({
              dataType: prop.dataType,
              required: prop.required,
              description: prop.description ?? existingProp.description,
              enumValues: prop.enumValues ?? existingProp.enumValues,
              itemType: prop.itemType ?? existingProp.itemType,
              constraints: prop.constraints ?? existingProp.constraints,
              example: prop.example ?? existingProp.example,
              updatedByUserId: ctx.userId,
            })
            .where(eq(db.schemaProperties.id, existingProp.id));
        } else {
          await tx.insert(db.schemaProperties).values({
            orgId: ctx.orgId,
            workspaceId: ctx.workspaceId,
            versionId: registry.draftVersionId!,
            relationshipTypeId: internalRelId,
            key: prop.key,
            dataType: prop.dataType,
            required: prop.required,
            description: prop.description,
            enumValues: prop.enumValues,
            itemType: prop.itemType,
            constraints: prop.constraints ?? {},
            example: prop.example,
            createdByUserId: ctx.userId,
            updatedByUserId: ctx.userId,
          });
        }
      }
    }

    return { relationshipTypeId, created };
  });

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      schemaName: input.schemaName,
      rel: input.name,
      created: result.created,
    },
    "schema.relationship.upsert: upserted relationship type",
  );

  return result;
};
