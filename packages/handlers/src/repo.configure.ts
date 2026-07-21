import type { CapabilityHandler } from "@oxagen/oxagen";
import { repoConfigure } from "@oxagen/oxagen/contracts/repo.configure";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { DeliveryConfig } from "@oxagen/ingestion/filters";
import { sourceConnectionRefCondition } from "./lib/connection-status";
import { logger } from "./logger";

/**
 * repo.configure — repo-specific configuration (filters,
 * sync cadence, field mappings) for a repository `source_connections` row. The
 * code-repo specialization of integration.configure; persists into the same
 * `deliveryConfig` JSONB so the ingestion pipeline and Inngest scheduler read
 * one config blob.
 *
 * Filter-shape reconciliation: the ingestion pipeline's DeliveryConfig reads
 * `pathFilters` / `labelFilters` as flat EXCLUDE glob lists (a record whose
 * path/label matches any pattern is dropped — see @oxagen/ingestion/filters).
 * The repo.configure contract exposes the richer `{ include, exclude }` shape.
 * We therefore:
 *   - write `exclude` into the pipeline-read `pathFilters` / `labelFilters`
 *     (string[]), so the live filter keeps working unchanged, and
 *   - persist `include` under `pathFiltersInclude` / `labelFiltersInclude`
 *     so the contract round-trips losslessly and a future include-aware pipeline
 *     stage can consume them.
 * Existing deliveryConfig is merged (not replaced) so connector-specific fields
 * set during the connection wizard (owner, repo, installationId) survive.
 */

// deliveryConfig keys that the repo contract adds on top of the pipeline's view.
type RepoDeliveryConfig = DeliveryConfig & {
  pathFiltersInclude?: string[];
  labelFiltersInclude?: string[];
  fieldMappings?: Record<string, string>;
};

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

export const repoConfigureHandler: CapabilityHandler<
  typeof repoConfigure
> = async (input, ctx) => {
  const now = new Date();

  const result = await withTenantDb(async (tx) => {
    const [existing] = await tx
      .select({
        id: schema.sourceConnections.id,
        displayName: schema.sourceConnections.displayName,
        deliveryConfig: schema.sourceConnections.deliveryConfig,
        deliveryMethod: schema.sourceConnections.deliveryMethod,
      })
      .from(schema.sourceConnections)
      .where(
        and(
          eq(schema.sourceConnections.orgId, ctx.orgId),
          eq(schema.sourceConnections.workspaceId, ctx.workspaceId),
          sourceConnectionRefCondition(input.repoId),
          isNull(schema.sourceConnections.deletedAt),
        ),
      )
      .limit(1);

    if (!existing) return null;

    const prev = (existing.deliveryConfig ?? {}) as RepoDeliveryConfig &
      Record<string, unknown>;

    // recordTypes (allow-list). Omitted input preserves the prior value.
    const recordTypeFilters = input.recordTypes ?? prev.recordTypeFilters ?? [];

    // path / label filters: exclude → pipeline list, include → companion key.
    const pathExclude = input.pathFilters
      ? asStringArray(input.pathFilters.exclude)
      : (prev.pathFilters ?? []);
    const pathInclude = input.pathFilters
      ? asStringArray(input.pathFilters.include)
      : (prev.pathFiltersInclude ?? []);
    const labelExclude = input.labelFilters
      ? asStringArray(input.labelFilters.exclude)
      : (prev.labelFilters ?? []);
    const labelInclude = input.labelFilters
      ? asStringArray(input.labelFilters.include)
      : (prev.labelFiltersInclude ?? []);

    const syncCadence = input.syncCadence ?? prev.syncMethod ?? "manual";
    // pollingIntervalSeconds is only meaningful for polling; preserve prior value
    // otherwise so switching cadence back and forth doesn't lose the interval.
    const syncIntervalSeconds =
      input.pollingIntervalSeconds ?? prev.syncIntervalSeconds ?? undefined;
    const fieldMappings = input.fieldMappings ?? prev.fieldMappings;

    const updated: RepoDeliveryConfig & Record<string, unknown> = {
      ...prev,
      recordTypeFilters,
      pathFilters: pathExclude,
      pathFiltersInclude: pathInclude,
      labelFilters: labelExclude,
      labelFiltersInclude: labelInclude,
      syncMethod: syncCadence,
      ...(syncIntervalSeconds !== undefined ? { syncIntervalSeconds } : {}),
      ...(fieldMappings !== undefined ? { fieldMappings } : {}),
    };

    await tx
      .update(schema.sourceConnections)
      .set({
        deliveryConfig: updated,
        updatedByUserId: ctx.userId ?? undefined,
        updatedAt: now,
      })
      .where(eq(schema.sourceConnections.id, existing.id));

    return {
      displayName: existing.displayName,
      recordTypes: recordTypeFilters,
      pathInclude,
      pathExclude,
      labelInclude,
      labelExclude,
      syncCadence,
      pollingIntervalSeconds: syncIntervalSeconds ?? null,
    };
  });

  if (!result) {
    logger.warn(
      { repoId: input.repoId, orgId: ctx.orgId },
      "repo.configure: not found",
    );
    throw new HTTPException(404, {
      message: "Repository connection not found",
    });
  }

  const pathFilters =
    result.pathInclude.length > 0 || result.pathExclude.length > 0
      ? { include: result.pathInclude, exclude: result.pathExclude }
      : null;
  const labelFilters =
    result.labelInclude.length > 0 || result.labelExclude.length > 0
      ? { include: result.labelInclude, exclude: result.labelExclude }
      : null;

  logger.info(
    {
      repoId: input.repoId,
      syncCadence: result.syncCadence,
      recordTypes: result.recordTypes.length,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    },
    "repo.configure: updated",
  );

  return {
    repoId: input.repoId,
    displayName: result.displayName,
    recordTypes: result.recordTypes,
    pathFilters,
    labelFilters,
    syncCadence: result.syncCadence,
    pollingIntervalSeconds: result.pollingIntervalSeconds,
    updatedAt: now.toISOString(),
  };
};
