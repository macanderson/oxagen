import type { CapabilityHandler, CapabilitySurface } from "@oxagen/oxagen";
import { schemaSetup } from "@oxagen/oxagen/contracts/schema.setup";
import { invoke } from "@oxagen/oxagen/kernel";
import { getOrCreateRegistry } from "./schema.versioning";
import { logger } from "./logger";

const toSurface = (s: string): CapabilitySurface =>
  (["api", "mcp", "agent", "cli"] as const).includes(s as CapabilitySurface)
    ? (s as CapabilitySurface)
    : "api";

export const schemaSetupHandler: CapabilityHandler<typeof schemaSetup> = async (
  input,
  ctx,
) => {
  const registry = await getOrCreateRegistry(
    ctx.orgId,
    ctx.workspaceId,
    ctx.userId,
  );

  // Step 1: Get a recommendation
  const recommendation = (await invoke(
    "recommend_schema",
    { sampleLimit: input.sampleLimit ?? 200 },
    ctx,
    { surface: toSurface(ctx.surface) },
  )) as {
    proposal: {
      schemas: Array<{
        name: string;
        displayName: string;
        labels: Array<{
          name: string;
          description?: string;
          properties?: Array<{
            key: string;
            dataType: string;
            required: boolean;
            description?: string;
          }>;
        }>;
        relationshipTypes: Array<{
          name: string;
          startLabel?: string;
          endLabel?: string;
          description?: string;
        }>;
      }>;
    };
    rationale: string;
    sampledCount: number;
  };

  // In interactive mode: just return counts + current pin (CLI drives the loop)
  if (!input.noInteractive) {
    const labelCount = recommendation.proposal.schemas.reduce(
      (acc, s) => acc + s.labels.length,
      0,
    );
    const relCount = recommendation.proposal.schemas.reduce(
      (acc, s) => acc + s.relationshipTypes.length,
      0,
    );

    return {
      schemasCreated: recommendation.proposal.schemas.length,
      labelsCreated: labelCount,
      relationshipTypesCreated: relCount,
      pinnedVersionId: registry.pinnedVersionId
        ? await resolvePublicId(registry.pinnedVersionId)
        : null,
    };
  }

  // Non-interactive mode: apply recommendation verbatim
  let schemasCreated = 0;
  let labelsCreated = 0;
  let relTypesCreated = 0;

  for (const schema of recommendation.proposal.schemas) {
    // Create labels
    for (const label of schema.labels) {
      await invoke(
        "upsert_schema_label",
        {
          schemaName: schema.name,
          name: label.name,
          displayName: label.name,
          description: label.description,
          properties: label.properties?.map((p) => ({
            key: p.key,
            dataType: p.dataType,
            required: p.required,
            description: p.description,
          })),
        },
        ctx,
        { surface: toSurface(ctx.surface) },
      );
      labelsCreated++;
    }

    // Create relationship types
    for (const rel of schema.relationshipTypes) {
      await invoke(
        "upsert_schema_relationship",
        {
          schemaName: schema.name,
          name: rel.name,
          displayName: rel.name,
          startLabel: rel.startLabel,
          endLabel: rel.endLabel,
          description: rel.description,
        },
        ctx,
        { surface: toSurface(ctx.surface) },
      );
      relTypesCreated++;
    }

    // Enable the schema (auto-publishes + auto-pins)
    await invoke(
      "toggle_schema",
      { schemaName: schema.name, enabled: true },
      ctx,
      { surface: toSurface(ctx.surface) },
    );

    schemasCreated++;
  }

  // Apply enforcement config if provided
  if (input.enforcement) {
    await invoke(
      "get_registry_config",
      { enforcementMode: input.enforcement },
      ctx,
      { surface: toSurface(ctx.surface) },
    );
  }

  // Re-read registry to get the new pinnedVersionId
  const updatedRegistry = await getOrCreateRegistry(
    ctx.orgId,
    ctx.workspaceId,
    ctx.userId,
  );

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      schemasCreated,
      labelsCreated,
      relTypesCreated,
    },
    "schema.setup: applied recommendation",
  );

  return {
    schemasCreated,
    labelsCreated,
    relationshipTypesCreated: relTypesCreated,
    pinnedVersionId: updatedRegistry.pinnedVersionId
      ? await resolvePublicId(updatedRegistry.pinnedVersionId)
      : null,
  };
};

async function resolvePublicId(internalId: string): Promise<string> {
  const database = await import("@oxagen/database");
  const db = database.schema;
  const { withTenantDb } = database;
  const { eq } = await import("drizzle-orm");
  return withTenantDb(async (tx) => {
    const [row] = await tx
      .select({ publicId: db.schemaVersions.publicId })
      .from(db.schemaVersions)
      .where(eq(db.schemaVersions.id, internalId))
      .limit(1);
    return row?.publicId ?? internalId;
  });
}
