import type { CapabilityHandler } from "@oxagen/oxagen";
import { schemaRegistryGet } from "@oxagen/oxagen/contracts/schema.registry.get";
import { schema as db, withTenantDb } from "@oxagen/database";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { getOrCreateRegistry } from "./schema.versioning";
import type { DataType } from "@oxagen/oxagen/contracts/schema.types";
import { logger } from "./logger";

type Cardinality = "one_to_one" | "one_to_many" | "many_to_many";

export const schemaRegistryGetHandler: CapabilityHandler<
  typeof schemaRegistryGet
> = async (input, ctx) => {
  const registry = await getOrCreateRegistry(
    ctx.orgId,
    ctx.workspaceId,
    ctx.userId,
  );

  // Determine which version to load. The builder is an editing surface, so the
  // default view must be the DRAFT (the working copy where every agent + manual
  // edit lands), not the pinned published version — otherwise newly scaffolded /
  // edited schemas are invisible until published. The draft is a superset of the
  // pinned version (publishing copies the draft forward), so this never hides
  // active schemas; the `enabled` flag distinguishes active ones. An explicit
  // `versionId` (e.g. selecting "Pinned version") still wins.
  const versionId =
    input.versionId ?? registry.draftVersionId ?? registry.pinnedVersionId;

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
    const enabledMap = new Map(
      activations.map((a) => [a.schemaName, a.enabled]),
    );

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

    // Load properties for this version (attached to labels OR relationship types).
    // The contract returns the full label/relationship/property tree; omitting
    // these made every label show "0 properties" in the builder even though the
    // agent scaffold / form authoring had defined them.
    const propRows = await tx
      .select()
      .from(db.schemaProperties)
      .where(
        and(
          eq(db.schemaProperties.versionId, resolvedVersionId),
          isNull(db.schemaProperties.deletedAt),
        ),
      );

    const mapProp = (p: (typeof propRows)[number]) => {
      const constraints = (p.constraints ?? {}) as Record<
        string,
        number | string
      >;
      return {
        key: p.key,
        dataType: p.dataType as DataType,
        required: p.required,
        description: p.description ?? undefined,
        enumValues: p.enumValues ?? undefined,
        itemType: p.itemType ?? undefined,
        constraints:
          Object.keys(constraints).length > 0 ? constraints : undefined,
        example: p.example ?? undefined,
      };
    };

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
          naturalKeyProps: l.naturalKeyProps ?? [],
          properties: propRows
            .filter((p) => p.nodeLabelId === l.id)
            .map(mapProp),
        })),
      relationshipTypes: rels
        .filter((r) => r.schemaId === s.id)
        .map((r) => ({
          name: r.name,
          displayName: r.displayName,
          startLabel: r.startLabel,
          endLabel: r.endLabel,
          cardinality: (r.cardinality as Cardinality | null) ?? null,
          properties: propRows
            .filter((p) => p.relationshipTypeId === r.id)
            .map(mapProp),
        })),
    }));
  });

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      schemaCount: schemas.length,
    },
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
