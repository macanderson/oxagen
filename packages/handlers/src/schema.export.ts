// schema.export.ts — build a ZIP of one schema-registry version.
//
// The ZIP is assembled here with fflate and persisted through the shared asset
// chokepoint. It used to compose the `create_archive` capability, which ADR-041
// removed along with the rest of the generation surface; exporting your own
// ontology is governance, not generation, so the ~20 lines of zip + persist it
// actually needed were inlined rather than keeping a capability alive for one
// caller.
import type { CapabilityHandler } from "@oxagen/oxagen";
import { schemaExport } from "@oxagen/oxagen/contracts/schema.export";
import { schema as db, withTenantDb } from "@oxagen/database";
import { eq, and, isNull } from "drizzle-orm";
import { getOrCreateRegistry } from "./schema.versioning";
import { persistGeneratedAsset } from "./generated-asset.persist";
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

  // Build the §15 ZIP layout:
  // manifest.json + schemas/<name>/labels/<Label>.json + schemas/<name>/relationships/<TYPE>.json
  //
  // Schema/label/relationship names are free-form tenant input (the
  // upsert_schema_label contract only bounds length), and entry names are
  // written into the ZIP verbatim. Every name that becomes a path segment is
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

  // An export is attributed to the user who asked for it — the asset row's
  // ownership column is NOT NULL and drives the `user` access policy — so an
  // API-key-only principal has no one to own the archive.
  if (!ctx.userId) {
    throw new Error(
      "schema.export requires an authenticated user (not an API-key-only principal)",
    );
  }

  // zipSync is fine here: every entry is a small JSON document already resident
  // in memory, so there is nothing to stream.
  const { zipSync } = await import("fflate");
  const encoder = new TextEncoder();
  const zipInput: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    zipInput[entry.name] = encoder.encode(entry.text);
  }
  const zipBytes = zipSync(zipInput, { level: 6 });

  const archiveName = `schema-export-v${versionNumber}`;
  const asset = await persistGeneratedAsset({
    orgId: ctx.orgId,
    workspaceId: ctx.workspaceId,
    userId: ctx.userId,
    kind: "archive",
    mimeType: "application/zip",
    bytes: zipBytes,
    prompt: "",
    model: "",
    displayName: archiveName,
    // Visible to the workspace: a schema export is a shared governance
    // artifact, not a personal download.
    accessPolicy: "org",
    messageId: ctx.messageId ?? undefined,
  });

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      versionNumber,
      assetId: asset.id,
      entryCount: entries.length,
      sizeBytes: asset.sizeBytes,
    },
    "schema.export: created archive",
  );

  return {
    assetId: asset.id,
    serveUrl: asset.serveUrl,
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
