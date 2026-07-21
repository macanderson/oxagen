import type { CapabilityHandler } from "@oxagen/oxagen";
import { integrationConfigure } from "@oxagen/oxagen/contracts/integration.configure";
import { schema, withTenantDb } from "@oxagen/database";
import { eq, and, isNull } from "drizzle-orm";
import type { DeliveryConfig } from "@oxagen/ingestion/filters";
import { logger } from "./logger";

/**
 * integration.configure handler.
 *
 * Reads the source connection from Postgres by public ID, patches the
 * deliveryConfig JSONB with the validated filter / cadence
 * settings from `input`, and writes the result back.
 *
 * deliveryConfig shape written:
 * {
 *   syncMethod: "manual" | "polling" | "webhook",
 *   syncIntervalSeconds: number,               // only meaningful when polling
 *   recordTypeFilters: string[],               // allow-list of source record types
 *   pathFilters: string[],                     // glob patterns to exclude paths
 *   labelFilters: string[],                    // glob patterns to exclude by label
 * }
 *
 * Merges with any existing deliveryConfig so callers can patch individual
 * fields without wiping unrelated config (e.g. connector-specific fields like
 * `owner`, `repo`, `installationId` set during the connection wizard).
 */
export const integrationConfigureHandler: CapabilityHandler<
  typeof integrationConfigure
> = async (input, ctx) => {
  // Resolve source connection by public ID
  const [row] = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.sourceConnections.id,
        publicId: schema.sourceConnections.publicId,
        displayName: schema.sourceConnections.displayName,
        deliveryConfig: schema.sourceConnections.deliveryConfig,
        deliveryMethod: schema.sourceConnections.deliveryMethod,
        updatedAt: schema.sourceConnections.updatedAt,
      })
      .from(schema.sourceConnections)
      .where(
        and(
          eq(schema.sourceConnections.publicId, input.integrationId),
          eq(schema.sourceConnections.orgId, ctx.orgId),
          eq(schema.sourceConnections.workspaceId, ctx.workspaceId),
          isNull(schema.sourceConnections.deletedAt),
        ),
      )
      .limit(1),
  );

  if (!row) {
    throw new Error(
      `integration.configure: integration not found: ${input.integrationId}`,
    );
  }

  // Build the updated deliveryConfig by merging existing fields with new values.
  // Preserves connector-specific fields (owner, repo, installationId, etc.) set
  // during the connection wizard that are unrelated to filter config.
  const existing = (row.deliveryConfig ?? {}) as DeliveryConfig &
    Record<string, unknown>;

  const syncCadence = input.syncCadence ?? existing.syncMethod ?? "manual";
  // Build the filter portion of deliveryConfig from input.config if
  // the caller supplied it. We pull well-known keys from config and validate them.
  const config = (input.config ?? {}) as Record<string, unknown>;

  const recordTypeFilters = validateStringArray(
    config["recordTypeFilters"] ?? existing.recordTypeFilters,
  );
  const pathFilters = validateStringArray(
    config["pathFilters"] ?? existing.pathFilters,
  );
  const labelFilters = validateStringArray(
    config["labelFilters"] ?? existing.labelFilters,
  );
  const syncIntervalSeconds = validatePositiveInteger(
    config["syncIntervalSeconds"] ?? existing.syncIntervalSeconds,
    300,
  );
  const updatedDeliveryConfig: DeliveryConfig & Record<string, unknown> = {
    // Preserve connector-specific fields (spread first so our typed fields win)
    ...existing,
    syncMethod: syncCadence,
    syncIntervalSeconds,
    recordTypeFilters,
    pathFilters,
    labelFilters,
  };

  const displayName = input.displayName ?? row.displayName;
  const now = new Date();

  await withTenantDb((tx) =>
    tx
      .update(schema.sourceConnections)
      .set({
        displayName,
        deliveryConfig: updatedDeliveryConfig,
        updatedAt: now,
      })
      .where(eq(schema.sourceConnections.id, row.id)),
  );

  logger.info(
    {
      integrationId: input.integrationId,
      connectionId: row.id,
      syncMethod: syncCadence,
      syncIntervalSeconds:
        syncCadence === "polling" ? syncIntervalSeconds : undefined,
      recordTypeFilters: recordTypeFilters.length,
      pathFilters: pathFilters.length,
      labelFilters: labelFilters.length,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    },
    "integration.configure: updated",
  );

  return {
    integrationId: input.integrationId,
    displayName,
    syncCadence,
    updatedAt: now.toISOString(),
  };
};

// ---------------------------------------------------------------------------
// Validators — narrow unknown inputs from JSONB / contract config to safe types
// ---------------------------------------------------------------------------

function validateStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function validatePositiveInteger(value: unknown, defaultValue: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.round(value);
  }
  return defaultValue;
}
