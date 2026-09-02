import type { CapabilityHandler } from "@oxagen/oxagen";
import { schemaRegistryConfig } from "@oxagen/oxagen/contracts/schema.registry.config";
import { schema as db, withTenantDb } from "@oxagen/database";
import { eq, and, isNull } from "drizzle-orm";
import { getOrCreateRegistry } from "./schema.versioning";
import { invalidatePinnedSchemaCache } from "./schema.pinned";
import { logger } from "./logger";

export const schemaRegistryConfigHandler: CapabilityHandler<
  typeof schemaRegistryConfig
> = async (input, ctx) => {
  const registry = await getOrCreateRegistry(
    ctx.orgId,
    ctx.workspaceId,
    ctx.userId,
  );

  const updated = await withTenantDb(async (tx) => {
    const [row] = await tx
      .update(db.schemaRegistries)
      .set({
        ...(input.enforcementMode !== undefined
          ? { enforcementMode: input.enforcementMode }
          : {}),
        ...(input.conformanceFloor !== undefined
          ? { conformanceFloor: String(input.conformanceFloor) }
          : {}),
        updatedByUserId: ctx.userId,
      })
      .where(
        and(
          eq(db.schemaRegistries.id, registry.id),
          isNull(db.schemaRegistries.deletedAt),
        ),
      )
      .returning();

    if (!row) throw new Error("Failed to update registry config");
    return row;
  });

  // enforcementMode and conformanceFloor are baked into the cached PinnedSchema,
  // and a cache hit is keyed only on version + activation fingerprint — neither
  // of which moves here. Without this drop, a lenient→strict switch keeps
  // validating against the old mode for the life of the process.
  invalidatePinnedSchemaCache(ctx.workspaceId);

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      enforcementMode: updated.enforcementMode,
      conformanceFloor: updated.conformanceFloor,
    },
    "schema.registry.config: updated config",
  );

  return {
    registryId: updated.publicId,
    enforcementMode: updated.enforcementMode as "strict" | "lenient" | "off",
    conformanceFloor: parseFloat(String(updated.conformanceFloor)),
  };
};
