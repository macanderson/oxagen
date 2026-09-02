import type { CapabilityHandler } from "@oxagen/oxagen";
import { schemaExport } from "@oxagen/oxagen/contracts/schema.export";
import { invoke } from "@oxagen/oxagen/kernel";
import { schema as db, withTenantDb } from "@oxagen/database";
import { eq, and, isNull } from "drizzle-orm";
import { getOrCreateRegistry } from "./schema.versioning";
import { logger } from "./logger";

export const schemaExportHandler: CapabilityHandler<
  typeof schemaExport
> = async (input, ctx) => {
  const registry = await getOrCreateRegistry(
    ctx.orgId,
    ctx.workspaceId,
    ctx.userId,
  );

  // Determine which version to export (default: pinned, then draft)
  const targetPublicId =
    input.versionId ??
    (registry.pinnedVersionId
      ? await resolvePublicId(registry.pinnedVersionId)
      : registry.draftVersionId
        ? await resolvePublicId(registry.draftVersionId)
        : null);

  if (!targetPublicId) {
    throw new Error("No version available to export");
  }

  const { schemas, labels, rels, props, versionNumber } = await withTenantDb(
    async (tx) => {
      // Resolve internal id from publicId
      const [versionRow] = await tx
        .select()
        .from(db.schemaVersions)
        .where(eq(db.schemaVersions.publicId, targetPublicId))
        .limit(1);

      if (!versionRow) throw new Error(`Version ${targetPublicId} not found`);

      const schemaRows = await tx
        .select()
        .from(db.schemas)
        .where(
          and(
            eq(db.schemas.versionId, versionRow.id),
            isNull(db.schemas.deletedAt),
          ),
        );

      const schemaIds = schemaRows.map((s) => s.id);

      const [labels, rels] = await Promise.all([
        schemaIds.length > 0
          ? tx
              .select()
              .from(db.nodeLabels)
              .where(
                and(
                  eq(db.nodeLabels.versionId, versionRow.id),
                  isNull(db.nodeLabels.deletedAt),
                ),
              )
          : Promise.resolve([]),
        schemaIds.length > 0
          ? tx
              .select()
              .from(db.relationshipTypes)
              .where(
                and(
                  eq(db.relationshipTypes.versionId, versionRow.id),
                  isNull(db.relationshipTypes.deletedAt),
                ),
              )
          : Promise.resolve([]),
      ]);

      const props = await tx
        .select()
        .from(db.schemaProperties)
        .where(
          and(
            eq(db.schemaProperties.versionId, versionRow.id),
            isNull(db.schemaProperties.deletedAt),
          ),
        );

      return {
        schemas: schemaRows,
        labels,
        rels,
        props,
        versionNumber: versionRow.versionNumber,
      };
    },
  );

  // Build the §15 ZIP layout as archive.create entries
  // manifest.json + schemas/<name>/labels/<Label>.json + schemas/<name>/relationships/<TYPE>.json
  //
  // Schema/label/relationship names are free-form tenant input (the
  // upsert_schema_label contract only bounds length), and archive.create writes
  // entry names into the ZIP verbatim. Every name that becomes a path segment is
  // therefore flattened through safePathSegment so an authored name can never
  // introduce a separator or a `..` hop into the archive.

  const entries: Array<{ name: string; text: string }> = [];

  // Manifest
  const manifest = {
    version: targetPublicId,
    versionNumber,
    exportedAt: new Date().toISOString(),
    schemas: schemas.map((s) => s.name),
  };
  entries.push({
    name: "manifest.json",
    text: JSON.stringify(manifest, null, 2),
  });

  // Per-schema files
  for (const s of schemas) {
    const schemaLabels = labels.filter((l) => l.schemaId === s.id);
    const schemaRels = rels.filter((r) => r.schemaId === s.id);

    for (const l of schemaLabels) {
      const labelProps = props.filter((p) => p.nodeLabelId === l.id);
      const labelDoc = {
        name: l.name,
        displayName: l.displayName,
        description: l.description,
        naturalKeyProps: l.naturalKeyProps,
        properties: labelProps.map((p) => ({
          key: p.key,
          dataType: p.dataType,
          required: p.required,
          description: p.description,
          enumValues: p.enumValues,
          itemType: p.itemType,
          example: p.example,
        })),
      };
      entries.push({
        name: `schemas/${safePathSegment(s.name)}/labels/${safePathSegment(l.name)}.json`,
        text: JSON.stringify(labelDoc, null, 2),
      });
    }

    for (const r of schemaRels) {
      const relProps = props.filter((p) => p.relationshipTypeId === r.id);
      const relDoc = {
        name: r.name,
        displayName: r.displayName,
        description: r.description,
        startLabel: r.startLabel,
        endLabel: r.endLabel,
        cardinality: r.cardinality,
        properties: relProps.map((p) => ({
          key: p.key,
          dataType: p.dataType,
          required: p.required,
          description: p.description,
        })),
      };
      entries.push({
        name: `schemas/${safePathSegment(s.name)}/relationships/${safePathSegment(r.name)}.json`,
        text: JSON.stringify(relDoc, null, 2),
      });
    }
  }

  // Invoke archive.create
  const archiveResult = (await invoke(
    "create_archive",
    {
      archiveName: `schema-export-v${versionNumber}`,
      entries,
    },
    ctx,
    { surface: "api" },
  )) as { assetId: string; serveUrl: string; publicId: string };

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      versionNumber,
      assetId: archiveResult.assetId,
    },
    "schema.export: created archive",
  );

  return {
    assetId: archiveResult.assetId,
    serveUrl: archiveResult.serveUrl,
    versionId: targetPublicId,
    versionNumber,
  };
};

/**
 * Flatten one authored name into a single, contained ZIP path segment.
 *
 * Anything that could act as a separator or a parent hop — a slash, a backslash,
 * or a leading run of dots — becomes `_`; ordinary names such as `Person` or
 * `RELATES_TO` pass through untouched. An empty result falls back to `unnamed`
 * so a segment is never blank.
 */
function safePathSegment(name: string): string {
  const flattened = name.replace(/[/\\]/g, "_").replace(/^\.+/, "_");
  return flattened.trim() || "unnamed";
}

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
