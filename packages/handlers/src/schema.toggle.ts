import type { CapabilityHandler } from "@oxagen/oxagen";
import { schemaToggle } from "@oxagen/oxagen/contracts/schema.toggle";
import { schema as db, withTenantDb } from "@oxagen/database";
import { eq, and, isNull } from "drizzle-orm";
import {
  getOrCreateRegistry,
  isDraftDirty,
  publishDraft,
  pinVersion,
} from "./schema.versioning";
import { invalidatePinnedSchemaCache } from "./schema.pinned";
import { logger } from "./logger";

export const schemaToggleHandler: CapabilityHandler<
  typeof schemaToggle
> = async (input, ctx) => {
  const { schemaName, enabled } = input;

  // 1. Load/create registry
  const registry = await getOrCreateRegistry(
    ctx.orgId,
    ctx.workspaceId,
    ctx.userId,
  );

  // 2. Upsert the schema_activations row
  await withTenantDb(async (tx) => {
    const [existing] = await tx
      .select()
      .from(db.schemaActivations)
      .where(
        and(
          eq(db.schemaActivations.workspaceId, ctx.workspaceId),
          eq(db.schemaActivations.schemaName, schemaName),
          isNull(db.schemaActivations.deletedAt),
        ),
      )
      .limit(1);

    if (existing) {
      await tx
        .update(db.schemaActivations)
        .set({ enabled, updatedByUserId: ctx.userId })
        .where(eq(db.schemaActivations.id, existing.id));
    } else {
      await tx.insert(db.schemaActivations).values({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        schemaName,
        enabled,
        createdByUserId: ctx.userId,
        updatedByUserId: ctx.userId,
      });
    }
  });

  // 3. Auto-publish if draft is dirty
  let publishedVersionId: string | null = null;
  let pinnedVersionId: string | null = registry.pinnedVersionId
    ? await resolvePublicId(registry.pinnedVersionId)
    : null;

  if (registry.draftVersionId) {
    const dirty = await isDraftDirty(
      ctx.orgId,
      ctx.workspaceId,
      registry.draftVersionId,
      registry.pinnedVersionId,
    );

    if (dirty) {
      logger.info(
        { workspaceId: ctx.workspaceId, schemaName },
        "schema.toggle: draft is dirty, auto-publishing",
      );

      const published = await publishDraft(
        ctx.orgId,
        ctx.workspaceId,
        registry.id,
        registry.draftVersionId,
        ctx.userId,
        `Auto-published by schema.toggle (${schemaName} → ${enabled ? "enabled" : "disabled"})`,
        undefined,
      );

      publishedVersionId = published.versionId;

      // 4. Auto-pin the newly published version
      const pinResult = await pinVersion(
        ctx.orgId,
        ctx.workspaceId,
        registry.id,
        registry.id,
        published.versionId,
        ctx.userId,
      );

      pinnedVersionId = pinResult.pinnedVersionId;

      const isDowngrade = pinResult.isDowngrade;
      const reconcileRecommended = isDowngrade || !enabled;

      logger.info(
        {
          workspaceId: ctx.workspaceId,
          schemaName,
          publishedVersionId,
          pinnedVersionId,
        },
        "schema.toggle: auto-published and pinned",
      );

      await invalidatePinnedSchemaCache(ctx.workspaceId);

      return {
        schemaName,
        enabled,
        publishedVersionId,
        pinnedVersionId,
        isDowngrade,
        reconcileRecommended,
      };
    }
  }

  // No dirty draft — just invalidate cache and return current pin
  await invalidatePinnedSchemaCache(ctx.workspaceId);

  logger.info(
    { workspaceId: ctx.workspaceId, schemaName, enabled },
    "schema.toggle: toggled without publish",
  );

  return {
    schemaName,
    enabled,
    publishedVersionId: null,
    pinnedVersionId,
    isDowngrade: false,
    reconcileRecommended: !enabled,
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
