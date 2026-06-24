import type { CapabilityHandler } from "@oxagen/oxagen";
import { schemaRegistryGet } from "@oxagen/oxagen/contracts/schema.registry.get";
import { schema as db, withTenantDb } from "@oxagen/database";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { getOrCreateRegistry } from "./schema.versioning";
import { logger } from "./logger";

export const schemaRegistryGetHandler: CapabilityHandler<typeof schemaRegistryGet> = async (
  input,
  ctx,
) => {
  const registry = await getOrCreateRegistry(ctx.orgId, ctx.workspaceId, ctx.userId);

  // Determine which version to load
  const versionId = input.versionId ?? registry.pinnedVersionId ?? registry.draftVersionId;

  const schemas = await withTenantDb(async (tx) => {
    if (!versionId) return [];

    // Load the version row to resolve its internal UUID from publicId
    let resolvedVersionId = versionId;
    const [versionRow] = await tx
      .select({ id: db.schemaVersions.id })
      .from(db.schemaVersions)
      .where(eq(db.schemaVersions.publicId, versionId))
      .limit(1);
    if (versionRow) resolvedVersionId = versionRow.id;

    // Load schemas in this version
    const schemaRows = await tx
      .select()
      .from(db.schemas)
      .where(
        and(
          eq(db.schemas.versionId, resolvedVersionId),
          isNull(db.schemas.deletedAt),
        ),
      );

    if (schemaRows.length === 0) return [];

    const schemaNames = schemaRows.map((s) => s.name);
    const schemaIds = schemaRows.map((s) => s.id);

    // Load activations
    const activations = await tx
      .select()
      .from(db.schemaActivations)
      .where(
        and(
          eq(db.schemaActivations.workspaceId, ctx.workspaceId),
          inArray(db.schemaActivations.schemaName, schemaNames),
          isNull(db.schemaActivations.deletedAt),
        ),
      );
    const enabledMap = new Map(activations.map((a) => [a.schemaName, a.enabled]));

    // Load node labels
    const labels = await tx
      .select()
      .from(db.nodeLabels)
      .where(
        and(
          eq(db.nodeLabels.versionId, resolvedVersionId),
          inArray(db.nodeLabels.schemaId, schemaIds),
          isNull(db.nodeLabels.deletedAt),
        ),
      );

    // Load relationship types
    const rels = await tx
      .select()
      .from(db.relationshipTypes)
      .where(
        and(
          eq(db.relationshipTypes.versionId, resolvedVersionId),
          inArray(db.relationshipTypes.schemaId, schemaIds),
          isNull(db.relationshipTypes.deletedAt),
        ),
      );

    return schemaRows.map((s) => ({
      schemaName: s.name,
      displayName: s.displayName,
      source: s.source as "user" | "connector" | "recommended",
      connectorId: s.connectorId ?? undefined,
      enabled: enabledMap.get(s.name) ?? true, // missing row → enabled
      labels: labels
        .filter((l) => l.schemaId === s.id)
        .map((l) => ({
          name: l.name,
          displayName: l.displayName,
          description: l.description,
        })),
      relationshipTypes: rels
        .filter((r) => r.schemaId === s.id)
        .map((r) => ({
          name: r.name,
          displayName: r.displayName,
          startLabel: r.startLabel,
          endLabel: r.endLabel,
        })),
    }));
  });

  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, schemaCount: schemas.length },
    "schema.registry.get: fetched registry",
  );

  return {
    registryId: registry.publicId,
    pinnedVersionId: registry.pinnedVersionId
      ? await resolvePublicId(registry.pinnedVersionId)
      : null,
    draftVersionId: registry.draftVersionId
      ? await resolvePublicId(registry.draftVersionId)
      : null,
    enforcementMode: registry.enforcementMode as "strict" | "lenient" | "off",
    conformanceFloor: parseFloat(String(registry.conformanceFloor)),
    schemas,
  };
};

async function resolvePublicId(internalId: string): Promise<string> {
  return withTenantDb(async (tx) => {
    const [row] = await tx
      .select({ publicId: db.schemaVersions.publicId })
      .from(db.schemaVersions)
      .where(eq(db.schemaVersions.id, internalId))
      .limit(1);
    return row?.publicId ?? internalId;
  });
}
