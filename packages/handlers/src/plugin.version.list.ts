import type { CapabilityHandler } from "@oxagen/oxagen";
import { pluginVersionList } from "@oxagen/oxagen/contracts/plugin.version.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, desc, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { loadBuiltInSchema } from "@oxagen/ingestion/connector-schema-loader";
import { getOxagenPlugin } from "@oxagen/oxagen/plugins";
import { logger } from "./logger";

/**
 * plugin.version.list — version history for a connector plugin.
 *
 * Data sources (real, no fabrication):
 *   - currentVersion: the live bundled connector schema (metadata.version) for
 *     built-in connectors, else the Oxagen plugin-registry manifest version.
 *     An unknown pluginId is a 404.
 *   - versions[]: the `ingestion.connector_schemas` cache, which records one row
 *     per (pluginId, pluginVersion) with the schema's cachedAt timestamp. That
 *     is the only persisted version-history source, so each entry's releasedAt
 *     is the real cachedAt; entries appear as schema versions are observed (the
 *     cache is populated by plugin.schema.get). When nothing has been cached
 *     yet, versions[] is empty while currentVersion still reflects the
 *     live bundled version.
 *   - installedVersion: currentVersion when this workspace has a non-deleted
 *     connection of this connector, else null. Per-connection schema versions
 *     are not tracked, so an installed connection reports the current version
 *     and hasBreakingUpdate is therefore false. Breaking-change flags are not
 *     persisted anywhere, so isBreaking is false for every entry.
 */
export const pluginVersionListHandler: CapabilityHandler<
  typeof pluginVersionList
> = async (input, ctx) => {
  const builtIn = loadBuiltInSchema(input.pluginId);
  const manifest = builtIn ? undefined : getOxagenPlugin(input.pluginId);

  const currentVersion = builtIn?.metadata.version ?? manifest?.version;
  if (!currentVersion) {
    logger.warn(
      { pluginId: input.pluginId },
      "plugin.version.list: unknown plugin",
    );
    throw new HTTPException(404, {
      message: `Unknown plugin: ${input.pluginId}`,
    });
  }

  // `ingestion.connector_schemas` is a shared/system catalog (no org_id) read
  // here through the non-superuser `oxagen_app` role. Where that role lacks
  // grants on it (Atlas re-baselines drop non-Drizzle GRANTs) the read throws
  // "permission denied" — so it is guarded and degrades to empty history rather
  // than 500ing the request. `currentVersion` (from the bundled YAML) and the
  // `isInstalled` check (a tenant table the role can always read) are unaffected.
  // Mirrors the resilience fix in plugin.schema.get.
  let historyRows: {
    pluginVersion: string;
    schemaVersion: string;
    cachedAt: Date;
    schema: unknown;
  }[] = [];
  try {
    historyRows = await withTenantDb((tx) =>
      tx
        .select({
          pluginVersion: schema.connectorSchemas.pluginVersion,
          schemaVersion: schema.connectorSchemas.schemaVersion,
          cachedAt: schema.connectorSchemas.cachedAt,
          schema: schema.connectorSchemas.schema,
        })
        .from(schema.connectorSchemas)
        .where(eq(schema.connectorSchemas.pluginId, input.pluginId))
        .orderBy(desc(schema.connectorSchemas.cachedAt))
        .limit(input.limit),
    );
  } catch (err) {
    logger.warn(
      { err, pluginId: input.pluginId },
      "plugin.version.list: connector_schemas read failed (non-fatal)",
    );
  }

  const installed = await withTenantDb((tx) =>
    tx
      .select({ id: schema.sourceConnections.id })
      .from(schema.sourceConnections)
      .where(
        and(
          eq(schema.sourceConnections.orgId, ctx.orgId),
          eq(schema.sourceConnections.workspaceId, ctx.workspaceId),
          eq(schema.sourceConnections.connectorId, input.pluginId),
          isNull(schema.sourceConnections.deletedAt),
        ),
      )
      .limit(1),
  );
  const isInstalled = installed.length > 0;

  const versions = historyRows.map((r) => {
    const meta = (
      r.schema as {
        metadata?: { changelog?: string; minimumPlatformVersion?: string };
      } | null
    )?.metadata;
    return {
      version: r.pluginVersion,
      releasedAt: r.cachedAt.toISOString(),
      // No breaking-change data is persisted, so this is false rather
      // than guessed. breakingChanges is omitted for the same reason.
      isBreaking: false,
      schemaVersion: r.schemaVersion,
      ...(input.includeChangelog && meta?.changelog
        ? { changelog: meta.changelog }
        : {}),
      ...(meta?.minimumPlatformVersion
        ? { minimumPlatformVersion: meta.minimumPlatformVersion }
        : {}),
    };
  });

  logger.info(
    {
      pluginId: input.pluginId,
      currentVersion,
      historyCount: versions.length,
      isInstalled,
      orgId: ctx.orgId,
    },
    "plugin.version.list: fetched",
  );

  return {
    pluginId: input.pluginId,
    currentVersion,
    installedVersion: isInstalled ? currentVersion : null,
    // installed == current (no per-connection version tracking) and no breaking
    // flags are persisted, so there is never a known breaking update to surface.
    hasBreakingUpdate: false,
    versions,
  };
};
