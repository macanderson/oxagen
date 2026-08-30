import type { CapabilityHandler } from "@oxagen/oxagen";
import { integrationGet } from "@oxagen/oxagen/contracts/integration.get";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { loadBuiltInSchema } from "@oxagen/ingestion/connector-schema-loader";
import {
  resolveConnectorVersion,
  toContractStatus,
} from "./lib/connection-status";
import { logger } from "./logger";

/**
 * integration.get — full detail for a single integration instance (an
 * `ingestion.source_connections` row; integrationId = publicId, matching the
 * shipped integration.sync/configure/metrics convention).
 *
 * `config` is the connection's deliveryConfig JSONB. `schema` is the connector's
 * bundled config schema (loaded from @oxagen/ingestion/connector-schema-loader)
 * so the UI can render the configuration form alongside the saved values; it is
 * null for connectors with no bundled schema. `version` is the connector's real
 * bundled schema version when available, else the platform version.
 */
export const integrationGetHandler: CapabilityHandler<
  typeof integrationGet
> = async (input, ctx) => {
  const [row] = await withTenantDb((tx) =>
    tx
      .select({
        publicId: schema.sourceConnections.publicId,
        connectorId: schema.sourceConnections.connectorId,
        displayName: schema.sourceConnections.displayName,
        status: schema.sourceConnections.status,
        deliveryConfig: schema.sourceConnections.deliveryConfig,
        entityCount: schema.sourceConnections.entityCount,
        lastSyncAt: schema.sourceConnections.lastSyncAt,
        errorMessage: schema.sourceConnections.errorMessage,
        createdAt: schema.sourceConnections.createdAt,
        updatedAt: schema.sourceConnections.updatedAt,
      })
      .from(schema.sourceConnections)
      .where(
        and(
          eq(schema.sourceConnections.orgId, ctx.orgId),
          eq(schema.sourceConnections.workspaceId, ctx.workspaceId),
          eq(schema.sourceConnections.publicId, input.integrationId),
          isNull(schema.sourceConnections.deletedAt),
        ),
      )
      .limit(1),
  );

  if (!row) {
    logger.warn(
      { integrationId: input.integrationId, orgId: ctx.orgId },
      "integration.get: not found",
    );
    throw new HTTPException(404, { message: "Integration not found" });
  }

  const connectorSchema = loadBuiltInSchema(row.connectorId);

  logger.info(
    {
      integrationId: input.integrationId,
      connectorId: row.connectorId,
      orgId: ctx.orgId,
    },
    "integration.get: fetched",
  );

  return {
    id: row.publicId,
    pluginId: row.connectorId,
    displayName: row.displayName,
    version: resolveConnectorVersion(row.connectorId),
    status: toContractStatus(row.status),
    config: (row.deliveryConfig as Record<string, unknown> | null) ?? {},
    schema: (connectorSchema as Record<string, unknown> | null) ?? null,
    entityCount: row.entityCount,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    errorMessage: row.errorMessage ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
};
