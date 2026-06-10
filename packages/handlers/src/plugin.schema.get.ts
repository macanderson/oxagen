import type { CapabilityHandler } from "@oxagen/oxagen";
import { pluginSchemaGet } from "@oxagen/oxagen/contracts/plugin.schema.get";
import type { ConnectorPluginSchema } from "@oxagen/oxagen/contracts/plugin.schema.get";
import { schema, withTenantDb } from "@oxagen/database";
import { desc, eq } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { loadBuiltInSchema } from "@oxagen/ingestion/connector-schema-loader";
import { logger } from "./logger";

export const pluginSchemaGetHandler: CapabilityHandler<typeof pluginSchemaGet> = async (input, _ctx) => {
  const { pluginId } = input;

  // 1. Check DB cache (connector_schemas table) — newest cachedAt first.
  const cached = await withTenantDb((tx) =>
    tx
      .select()
      .from(schema.connectorSchemas)
      .where(eq(schema.connectorSchemas.pluginId, pluginId))
      .orderBy(desc(schema.connectorSchemas.cachedAt))
      .limit(1),
  );

  if (cached[0]) {
    logger.info({ pluginId, source: "db_cache" }, "plugin.schema.get: cache hit");
    return cached[0].schema as ConnectorPluginSchema;
  }

  // 2. Load from bundled YAML for built-in connectors.
  const builtIn = loadBuiltInSchema(pluginId);

  if (builtIn) {
    // Persist to DB so future calls hit the cache.
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
            target: [schema.connectorSchemas.pluginId, schema.connectorSchemas.pluginVersion],
            set: {
              schema: builtIn as Record<string, unknown>,
              schemaVersion: builtIn.metadata.schemaVersion,
              cachedAt: new Date(),
              updatedAt: new Date(),
            },
          }),
      );
      logger.info({ pluginId, source: "built_in_yaml" }, "plugin.schema.get: loaded + cached");
    } catch (err) {
      // Cache write failure is non-fatal — still return the loaded schema.
      logger.warn({ err, pluginId }, "plugin.schema.get: DB cache write failed, returning from file");
    }

    return builtIn as ConnectorPluginSchema;
  }

  // 3. Partner plugin URL fetch is not yet implemented.
  logger.warn({ pluginId }, "plugin.schema.get: schema not found");
  throw new HTTPException(404, { message: `Schema not found for plugin: ${pluginId}` });
};
