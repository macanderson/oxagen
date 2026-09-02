import type { CapabilityHandler } from "@oxagen/oxagen";
import { pluginSchemaGet } from "@oxagen/oxagen/contracts/plugin.schema.get";
import type { ConnectorPluginSchema } from "@oxagen/oxagen/contracts/plugin.schema.get";
import { schema, withTenantDb } from "@oxagen/database";
import { desc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { loadBuiltInSchema } from "@oxagen/ingestion/connector-schema-loader";
import { logger } from "./logger";

export const pluginSchemaGetHandler: CapabilityHandler<
  typeof pluginSchemaGet
> = async (input, _ctx) => {
  const { pluginId } = input;

  // 1. Built-in connectors ship a bundled YAML schema — the source of truth.
  //    Resolve it FIRST so the connector Configure form never depends on the
  //    `ingestion.connector_schemas` cache table.
  //
  //    That table is a shared/system catalog (no org_id; explicitly excluded
  //    from the tenant-policy manifest), but it is read here through
  //    `withTenantDb`, which runs as the non-superuser `oxagen_app` role. In
  //    environments where that role lacks grants on the catalog (Atlas
  //    re-baselines drop non-Drizzle GRANTs), the read throws
  //    "permission denied for table connector_schemas" — and since the read was
  //    unguarded it surfaced as a 500 on EVERY `plugin.schema.get`, breaking the
  //    connector Configure form in prod. Built-ins never need the cache to be
  //    served, so we no longer let it gate the request.
  const builtIn = loadBuiltInSchema(pluginId);
  if (builtIn) {
    // Best-effort warm of the cross-instance DB cache. Any failure (missing
    // grant, RLS, table absent) is swallowed — the schema is already resolved.
    await cacheBuiltInSchema(pluginId, builtIn);
    return builtIn as ConnectorPluginSchema;
  }

  // 2. Partner plugins: consult the DB cache. Guarded so a cache-layer failure
  //    degrades to "not found" rather than a 500.
  try {
    const cached = await withTenantDb((tx) =>
      tx
        .select()
        .from(schema.connectorSchemas)
        .where(eq(schema.connectorSchemas.pluginId, pluginId))
        .orderBy(desc(schema.connectorSchemas.cachedAt))
        .limit(1),
    );
    if (cached[0]) {
      logger.info(
        { pluginId, source: "db_cache" },
        "plugin.schema.get: cache hit",
      );
      return cached[0].schema as ConnectorPluginSchema;
    }
  } catch (err) {
    logger.warn(
      { err, pluginId },
      "plugin.schema.get: connector_schemas read failed (non-fatal)",
    );
  }

  // 3. Partner plugin URL fetch is not yet implemented.
  logger.warn({ pluginId }, "plugin.schema.get: schema not found");
  throw new HTTPException(404, {
    message: `Schema not found for plugin: ${pluginId}`,
  });
};

/**
 * Best-effort write of a built-in connector schema into the cross-instance DB
 * cache. NEVER throws: a write failure (missing `oxagen_app` grant on the
 * `connector_schemas` system catalog, RLS, or an absent table) must not fail the
 * request, because the schema has already been resolved from the bundled YAML.
 */
async function cacheBuiltInSchema(
  pluginId: string,
  builtIn: NonNullable<ReturnType<typeof loadBuiltInSchema>>,
): Promise<void> {
  try {
    await withTenantDb((tx) =>
      tx
        .insert(schema.connectorSchemas)
        .values({
          pluginId,
          schema: builtIn as Record<string, unknown>,
          schemaVersion: builtIn.metadata.schemaVersion,
          pluginVersion: builtIn.metadata.version,
        })
        .onConflictDoUpdate({
          target: [
            schema.connectorSchemas.pluginId,
            schema.connectorSchemas.pluginVersion,
          ],
          set: {
            schema: builtIn as Record<string, unknown>,
            schemaVersion: builtIn.metadata.schemaVersion,
            cachedAt: new Date(),
            updatedAt: new Date(),
          },
        }),
    );
    logger.info(
      { pluginId, source: "built_in_yaml" },
      "plugin.schema.get: loaded + cached",
    );
  } catch (err) {
    logger.warn(
      { err, pluginId },
      "plugin.schema.get: DB cache write failed, returning from file",
    );
  }
}
