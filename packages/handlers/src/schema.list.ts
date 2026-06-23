import type { CapabilityHandler } from "@oxagen/oxagen";
import { schemaList } from "@oxagen/oxagen/contracts/schema.list";
import { schema as db, withTenantDb } from "@oxagen/database";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { getOrCreateRegistry } from "./schema.versioning";
import { logger } from "./logger";

export const schemaListHandler: CapabilityHandler<typeof schemaList> = async (_input, ctx) => {
  const registry = await getOrCreateRegistry(ctx.orgId, ctx.workspaceId, ctx.userId);

  // Use pinned version for reads; fall back to draft
  const versionInternalId = registry.pinnedVersionId ?? registry.draftVersionId;

  if (!versionInternalId) {
    return { schemas: [] };
  }

  const schemas = await withTenantDb(async (tx) => {
    const schemaRows = await tx
      .select()
      .from(db.schemas)
      .where(
        and(
          eq(db.schemas.versionId, versionInternalId),
          isNull(db.schemas.deletedAt),
        ),
      );

    if (schemaRows.length === 0) return [];

    const schemaNames = schemaRows.map((s) => s.name);

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

    return schemaRows.map((s) => ({
      schemaName: s.name,
      displayName: s.displayName,
      source: s.source as "user" | "connector" | "recommended",
      connectorId: s.connectorId ?? null,
      enabled: enabledMap.get(s.name) ?? true,
    }));
  });

  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, count: schemas.length },
    "schema.list: fetched schemas",
  );

  return { schemas };
};
