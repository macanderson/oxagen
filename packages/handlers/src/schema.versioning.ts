/**
 * schema.versioning — shared helpers for publish/pin lifecycle.
 *
 * Consumed by:
 *   schema.version.create  — explicit freeze+open-draft
 *   schema.toggle           — auto-publish-if-dirty + auto-pin
 *   schema.version.pin      — explicit pin
 */

import { schema as db, withTenantDb } from "@oxagen/database";
import { eq, and, isNull, sql } from "drizzle-orm";
import { invalidatePinnedSchemaCache } from "./schema.pinned";
import { logger } from "./logger";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PublishedVersion {
  versionId: string;
  versionNumber: number;
  publishedAt: string;
  newDraftVersionId: string;
}

export interface PinResult {
  pinnedVersionId: string;
  previousVersionId: string | null;
  isDowngrade: boolean;
  reconcileRecommended: boolean;
}

// ── Registry bootstrap ────────────────────────────────────────────────────────

/**
 * Load the workspace registry row, auto-creating it (with a draft version) if
 * it does not exist.
 */
export async function getOrCreateRegistry(
  orgId: string,
  workspaceId: string,
  userId: string | null,
) {
  return withTenantDb(async (tx) => {
    // Try to load existing
    const existing = await tx
      .select()
      .from(db.schemaRegistries)
      .where(
        and(
          eq(db.schemaRegistries.orgId, orgId),
          eq(db.schemaRegistries.workspaceId, workspaceId),
          isNull(db.schemaRegistries.deletedAt),
        ),
      )
      .limit(1);

    if (existing[0]) return existing[0];

    // Create a fresh registry + draft version in one shot
    const [registry] = await tx
      .insert(db.schemaRegistries)
      .values({
        orgId,
        workspaceId,
        createdByUserId: userId,
        updatedByUserId: userId,
        enforcementMode: "lenient",
        conformanceFloor: "0.50",
      })
      .returning();

    if (!registry) throw new Error("Failed to create registry");

    // Create the initial draft version (version number 1)
    const [draft] = await tx
      .insert(db.schemaVersions)
      .values({
        orgId,
        workspaceId,
        registryId: registry.id,
        versionNumber: 1,
        status: "draft",
        createdByUserId: userId,
        updatedByUserId: userId,
      })
      .returning();

    if (!draft) throw new Error("Failed to create draft version");

    // Update registry with draftVersionId
    const [updated] = await tx
      .update(db.schemaRegistries)
      .set({ draftVersionId: draft.id, updatedByUserId: userId })
      .where(eq(db.schemaRegistries.id, registry.id))
      .returning();

    logger.info(
      { orgId, workspaceId, registryId: registry.id, draftVersionId: draft.id },
      "schema.versioning: auto-created registry",
    );
    return updated ?? registry;
  });
}

// ── Draft dirtiness check ─────────────────────────────────────────────────────

/**
 * Whether the draft has anything worth publishing.
 *
 * With no pinned version: dirty if the draft holds any node label or
 * relationship type at all.
 *
 * With a pinned version: dirty only when the draft holds MORE labels +
 * relationship types than the pinned version does. This is a count comparison,
 * not a set comparison — a draft that renames or replaces a definition without
 * changing the total, or that only deletes, still reports clean. Tightening
 * this to a real set difference is tracked separately; the count heuristic is
 * what schema.toggle's auto-publish currently relies on.
 */
export async function isDraftDirty(
  orgId: string,
  workspaceId: string,
  draftVersionId: string,
  pinnedVersionId: string | null,
): Promise<boolean> {
  return withTenantDb(async (tx) => {
    // Count draft labels
    const [labelCount] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(db.nodeLabels)
      .where(
        and(
          eq(db.nodeLabels.versionId, draftVersionId),
          isNull(db.nodeLabels.deletedAt),
        ),
      );

    const [relCount] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(db.relationshipTypes)
      .where(
        and(
          eq(db.relationshipTypes.versionId, draftVersionId),
          isNull(db.relationshipTypes.deletedAt),
        ),
      );

    const draftHasContent = (labelCount?.n ?? 0) > 0 || (relCount?.n ?? 0) > 0;

    if (!pinnedVersionId) return draftHasContent;

    // If pinned exists, check whether draft has labels/rels not in pinned
    const [pinnedLabelCount] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(db.nodeLabels)
      .where(
        and(
          eq(db.nodeLabels.versionId, pinnedVersionId),
          isNull(db.nodeLabels.deletedAt),
        ),
      );

    const [pinnedRelCount] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(db.relationshipTypes)
      .where(
        and(
          eq(db.relationshipTypes.versionId, pinnedVersionId),
          isNull(db.relationshipTypes.deletedAt),
        ),
      );

    // Dirty if the draft holds more definitions than the pin (count heuristic —
    // see the doc comment for what this deliberately does not catch).
    const draftTotal = (labelCount?.n ?? 0) + (relCount?.n ?? 0);
    const pinnedTotal = (pinnedLabelCount?.n ?? 0) + (pinnedRelCount?.n ?? 0);
    return draftTotal > pinnedTotal;
  });
}

// ── Publish (freeze draft → published) ───────────────────────────────────────

/**
 * Freeze the current draft into a published snapshot, open a fresh draft.
 * Returns the published version info.
 *
 * Numbering: the draft row is RENUMBERED to `max(version_number) + 1` on
 * publish, and the fresh draft takes the number after that. Because the draft
 * is normally already the highest-numbered row, published versions therefore
 * land on 2, 4, 6, … — `versionNumber` is a monotonic ordering key, not a
 * "this is the Nth publish" counter, and callers must not present it as one.
 */
export async function publishDraft(
  orgId: string,
  workspaceId: string,
  registryId: string,
  draftVersionId: string,
  userId: string | null,
  label?: string,
  changeSummary?: string,
): Promise<PublishedVersion> {
  return withTenantDb(async (tx) => {
    const publishedAt = new Date();

    // 1. Get next version number
    const [maxRow] = await tx
      .select({ maxVer: sql<number>`max(version_number)::int` })
      .from(db.schemaVersions)
      .where(eq(db.schemaVersions.registryId, registryId));

    const nextNumber = (maxRow?.maxVer ?? 0) + 1;

    // 2. Freeze the draft: status → published, set publishedAt, label, changeSummary
    const [published] = await tx
      .update(db.schemaVersions)
      .set({
        status: "published",
        publishedAt,
        label: label ?? null,
        changeSummary: changeSummary ?? null,
        versionNumber: nextNumber,
        updatedByUserId: userId,
      })
      .where(eq(db.schemaVersions.id, draftVersionId))
      .returning();

    if (!published) throw new Error("Failed to publish draft version");

    // 3. No snapshot copy is needed for the published side: the draft row was
    //    frozen in place, so its existing schema/label/relationship/property
    //    children already point at the now-published versionId. Steps 4–8 copy
    //    that snapshot FORWARD into a brand-new draft instead.

    // 4. Open a fresh draft (version number = nextNumber + 1 reserved as next draft)
    const [newDraft] = await tx
      .insert(db.schemaVersions)
      .values({
        orgId,
        workspaceId,
        registryId,
        versionNumber: nextNumber + 1,
        status: "draft",
        parentVersionId: published.id,
        createdByUserId: userId,
        updatedByUserId: userId,
      })
      .returning();

    if (!newDraft) throw new Error("Failed to create new draft version");

    // 5. Copy schemas from published into new draft
    const publishedSchemas = await tx
      .select()
      .from(db.schemas)
      .where(
        and(
          eq(db.schemas.versionId, published.id),
          isNull(db.schemas.deletedAt),
        ),
      );

    const schemaIdMap = new Map<string, string>(); // old id → new id

    for (const s of publishedSchemas) {
      const [newSchema] = await tx
        .insert(db.schemas)
        .values({
          orgId,
          workspaceId,
          versionId: newDraft.id,
          name: s.name,
          displayName: s.displayName,
          description: s.description,
          source: s.source,
          connectorId: s.connectorId,
          createdByUserId: userId,
          updatedByUserId: userId,
        })
        .returning();
      if (newSchema) schemaIdMap.set(s.id, newSchema.id);
    }

    // 6. Copy node labels.
    //    Steps 6–8 skip any child whose parent failed to copy (`continue` on a
    //    missing map entry). A skip is silent: the forward copy drops the row
    //    from the new draft with no error and no counter, so a partial failure
    //    in step 5 shows up later as missing definitions, not as a failed
    //    publish.
    const publishedLabels = await tx
      .select()
      .from(db.nodeLabels)
      .where(
        and(
          eq(db.nodeLabels.versionId, published.id),
          isNull(db.nodeLabels.deletedAt),
        ),
      );

    const labelIdMap = new Map<string, string>(); // old id → new id

    for (const l of publishedLabels) {
      const newSchemaId = schemaIdMap.get(l.schemaId);
      if (!newSchemaId) continue;
      const [newLabel] = await tx
        .insert(db.nodeLabels)
        .values({
          orgId,
          workspaceId,
          versionId: newDraft.id,
          schemaId: newSchemaId,
          name: l.name,
          displayName: l.displayName,
          description: l.description,
          naturalKeyProps: l.naturalKeyProps,
          createdByUserId: userId,
          updatedByUserId: userId,
        })
        .returning();
      if (newLabel) labelIdMap.set(l.id, newLabel.id);
    }

    // 7. Copy relationship types
    const publishedRels = await tx
      .select()
      .from(db.relationshipTypes)
      .where(
        and(
          eq(db.relationshipTypes.versionId, published.id),
          isNull(db.relationshipTypes.deletedAt),
        ),
      );

    const relIdMap = new Map<string, string>();

    for (const r of publishedRels) {
      const newSchemaId = schemaIdMap.get(r.schemaId);
      if (!newSchemaId) continue;
      const [newRel] = await tx
        .insert(db.relationshipTypes)
        .values({
          orgId,
          workspaceId,
          versionId: newDraft.id,
          schemaId: newSchemaId,
          name: r.name,
          displayName: r.displayName,
          description: r.description,
          startLabel: r.startLabel,
          endLabel: r.endLabel,
          cardinality: r.cardinality,
          createdByUserId: userId,
          updatedByUserId: userId,
        })
        .returning();
      if (newRel) relIdMap.set(r.id, newRel.id);
    }

    // 8. Copy properties
    const publishedProps = await tx
      .select()
      .from(db.schemaProperties)
      .where(
        and(
          eq(db.schemaProperties.versionId, published.id),
          isNull(db.schemaProperties.deletedAt),
        ),
      );

    for (const p of publishedProps) {
      const newNodeLabelId = p.nodeLabelId
        ? labelIdMap.get(p.nodeLabelId)
        : undefined;
      const newRelTypeId = p.relationshipTypeId
        ? relIdMap.get(p.relationshipTypeId)
        : undefined;
      if (!newNodeLabelId && !newRelTypeId) continue;
      await tx.insert(db.schemaProperties).values({
        orgId,
        workspaceId,
        versionId: newDraft.id,
        nodeLabelId: newNodeLabelId ?? null,
        relationshipTypeId: newRelTypeId ?? null,
        key: p.key,
        dataType: p.dataType,
        required: p.required,
        description: p.description,
        enumValues: p.enumValues,
        itemType: p.itemType,
        constraints: p.constraints,
        example: p.example,
        createdByUserId: userId,
        updatedByUserId: userId,
      });
    }

    // 9. Update registry draftVersionId pointer
    await tx
      .update(db.schemaRegistries)
      .set({ draftVersionId: newDraft.id, updatedByUserId: userId })
      .where(eq(db.schemaRegistries.id, registryId));

    logger.info(
      {
        orgId,
        workspaceId,
        registryId,
        publishedVersionId: published.id,
        newDraftVersionId: newDraft.id,
      },
      "schema.versioning: published draft and opened new draft",
    );

    return {
      versionId: published.publicId,
      versionNumber: nextNumber,
      publishedAt: publishedAt.toISOString(),
      newDraftVersionId: newDraft.id,
    };
  });
}

// ── Pin ───────────────────────────────────────────────────────────────────────

/**
 * Point registries.pinnedVersionId at the given published version.
 * Returns previous pin info and downgrade flag.
 *
 * `orgId` and `registryId` are unused — every query keys off `registryRowId`,
 * and both call sites (schema.toggle, schema.version.pin) already pass
 * `registry.id` for BOTH id parameters. Collapsing them is a signature change,
 * so it is left to a dedicated change rather than done here.
 */
export async function pinVersion(
  orgId: string,
  workspaceId: string,
  registryId: string,
  registryRowId: string,
  newVersionId: string,
  userId: string | null,
): Promise<PinResult> {
  return withTenantDb(async (tx) => {
    // Load requested version (by publicId)
    const [targetVersion] = await tx
      .select()
      .from(db.schemaVersions)
      .where(
        and(
          eq(db.schemaVersions.publicId, newVersionId),
          eq(db.schemaVersions.registryId, registryRowId),
        ),
      )
      .limit(1);

    if (!targetVersion) {
      throw new Error(`Version ${newVersionId} not found in registry`);
    }
    if (targetVersion.status !== "published") {
      throw new Error(`Version ${newVersionId} is not published`);
    }

    // Load current pinned version number for downgrade detection
    const [registry] = await tx
      .select()
      .from(db.schemaRegistries)
      .where(eq(db.schemaRegistries.id, registryRowId))
      .limit(1);

    let previousVersionId: string | null = null;
    let isDowngrade = false;

    if (registry?.pinnedVersionId) {
      const [prevVersion] = await tx
        .select()
        .from(db.schemaVersions)
        .where(eq(db.schemaVersions.id, registry.pinnedVersionId))
        .limit(1);

      if (prevVersion) {
        previousVersionId = prevVersion.publicId;
        isDowngrade = targetVersion.versionNumber < prevVersion.versionNumber;
      }
    }

    // Update pin
    await tx
      .update(db.schemaRegistries)
      .set({ pinnedVersionId: targetVersion.id, updatedByUserId: userId })
      .where(eq(db.schemaRegistries.id, registryRowId));

    await invalidatePinnedSchemaCache(workspaceId);

    return {
      pinnedVersionId: targetVersion.publicId,
      previousVersionId,
      isDowngrade,
      reconcileRecommended: isDowngrade,
    };
  });
}

// ── Draft schema resolver ─────────────────────────────────────────────────────

/**
 * Get or create a schema row within the draft version.
 * Per §4.3: user/recommended schemas are born disabled.
 */
export async function getOrCreateDraftSchema(
  orgId: string,
  workspaceId: string,
  draftVersionId: string,
  schemaName: string,
  userId: string | null,
  tx: Parameters<Parameters<typeof withTenantDb>[0]>[0],
) {
  const [existing] = await tx
    .select()
    .from(db.schemas)
    .where(
      and(
        eq(db.schemas.versionId, draftVersionId),
        eq(db.schemas.name, schemaName),
        isNull(db.schemas.deletedAt),
      ),
    )
    .limit(1);

  if (existing) return { schema: existing, created: false };

  // Create schema row
  const [created] = await tx
    .insert(db.schemas)
    .values({
      orgId,
      workspaceId,
      versionId: draftVersionId,
      name: schemaName,
      displayName: schemaName,
      source: "user",
      createdByUserId: userId,
      updatedByUserId: userId,
    })
    .returning();

  if (!created) throw new Error(`Failed to create schema ${schemaName}`);

  // Born-disabled: insert a disabled schema_activations row (§4.3)
  const existingActivation = await tx
    .select()
    .from(db.schemaActivations)
    .where(
      and(
        eq(db.schemaActivations.workspaceId, workspaceId),
        eq(db.schemaActivations.schemaName, schemaName),
        isNull(db.schemaActivations.deletedAt),
      ),
    )
    .limit(1);

  if (!existingActivation[0]) {
    await tx.insert(db.schemaActivations).values({
      orgId,
      workspaceId,
      schemaName,
      enabled: false,
      createdByUserId: userId,
      updatedByUserId: userId,
    });
  }

  return { schema: created, created: true };
}
