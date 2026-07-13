import type { CapabilityHandler } from "@oxagen/oxagen";
import { schemaLabelUpsert } from "@oxagen/oxagen/contracts/schema.label.upsert";
import { schema as db, withTenantDb } from "@oxagen/database";
import { eq, and, isNull } from "drizzle-orm";
import {
  getOrCreateRegistry,
  getOrCreateDraftSchema,
} from "./schema.versioning";
import { logger } from "./logger";

export const schemaLabelUpsertHandler: CapabilityHandler<
  typeof schemaLabelUpsert
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
    // Resolve or create the schema within the draft
    const { schema: schemaRow } = await getOrCreateDraftSchema(
      ctx.orgId,
      ctx.workspaceId,
      registry.draftVersionId!,
      input.schemaName,
      ctx.userId,
      tx,
    );

    // Upsert the node label
    const [existing] = await tx
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

    let labelId: string;
    let created: boolean;

    if (existing) {
      const [updated] = await tx
        .update(db.nodeLabels)
        .set({
          displayName: input.displayName,
          description: input.description ?? existing.description,
          naturalKeyProps: input.naturalKeyProps ?? existing.naturalKeyProps,
          updatedByUserId: ctx.userId,
        })
        .where(eq(db.nodeLabels.id, existing.id))
        .returning();
      labelId = updated?.publicId ?? existing.publicId;
      created = false;
    } else {
      const [inserted] = await tx
        .insert(db.nodeLabels)
        .values({
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          versionId: registry.draftVersionId!,
          schemaId: schemaRow.id,
          name: input.name,
          displayName: input.displayName,
          description: input.description,
          naturalKeyProps: input.naturalKeyProps ?? [],
          createdByUserId: ctx.userId,
          updatedByUserId: ctx.userId,
        })
        .returning();
      if (!inserted)
        throw new Error(`Failed to insert node label ${input.name}`);
      labelId = inserted.publicId;
      created = true;
    }

    // Get internal label UUID for property inserts
    const [labelRow] = await tx
      .select({ id: db.nodeLabels.id })
      .from(db.nodeLabels)
      .where(eq(db.nodeLabels.publicId, labelId))
      .limit(1);

    const internalLabelId = labelRow?.id ?? existing?.id;

    // Upsert properties if provided
    if (input.properties && input.properties.length > 0 && internalLabelId) {
      for (const prop of input.properties) {
        const [existingProp] = await tx
          .select()
          .from(db.schemaProperties)
          .where(
            and(
              eq(db.schemaProperties.nodeLabelId, internalLabelId),
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
            nodeLabelId: internalLabelId,
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

    return { labelId, created };
  });

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      schemaName: input.schemaName,
      label: input.name,
      created: result.created,
    },
    "schema.label.upsert: upserted label",
  );

  return result;
};
