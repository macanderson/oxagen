import type { CapabilityHandler } from "@oxagen/oxagen";
import { integrationList } from "@oxagen/oxagen/contracts/integration.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull, desc, count } from "drizzle-orm";
import {
  CONTRACT_STATUS_TO_DB_STATUS,
  resolveConnectorVersion,
  toContractStatus,
} from "./lib/connection-status";
import { logger } from "./logger";

/**
 * integration.list — browse installed integration instances. An integration is
 * an `ingestion.source_connections` row (matching the shipped
 * integration.sync/configure/metrics convention, where integrationId =
 * source_connections.publicId). Tenant-scoped, soft-delete aware, paginated.
 *
 * `status` filter is a contract status ('active' | 'paused' | 'failed' |
 * 'pending_setup'); it's translated to the DB status before the query (e.g.
 * 'active' → 'connected'). `pluginId` filter matches source_connections.connectorId.
 */
export const integrationListHandler: CapabilityHandler<
  typeof integrationList
> = async (input, ctx) => {
  const conditions = [
    eq(schema.sourceConnections.orgId, ctx.orgId),
    eq(schema.sourceConnections.workspaceId, ctx.workspaceId),
    isNull(schema.sourceConnections.deletedAt),
  ];
  if (input.status) {
    conditions.push(
      eq(
        schema.sourceConnections.status,
        CONTRACT_STATUS_TO_DB_STATUS[input.status],
      ),
    );
  }
  if (input.pluginId) {
    conditions.push(eq(schema.sourceConnections.connectorId, input.pluginId));
  }
  const where = and(...conditions);

  const { rows, total } = await withTenantDb(async (tx) => {
    const [{ value: total } = { value: 0 }] = await tx
      .select({ value: count() })
      .from(schema.sourceConnections)
      .where(where);

    const rows = await tx
      .select({
        publicId: schema.sourceConnections.publicId,
        connectorId: schema.sourceConnections.connectorId,
        displayName: schema.sourceConnections.displayName,
        status: schema.sourceConnections.status,
        lastSyncAt: schema.sourceConnections.lastSyncAt,
        entityCount: schema.sourceConnections.entityCount,
        errorMessage: schema.sourceConnections.errorMessage,
        createdAt: schema.sourceConnections.createdAt,
      })
      .from(schema.sourceConnections)
      .where(where)
      .orderBy(desc(schema.sourceConnections.createdAt))
      .limit(input.limit)
      .offset(input.offset);

    return { rows, total };
  });

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      count: rows.length,
      total,
    },
    "integration.list: fetched",
  );

  return {
    integrations: rows.map((r) => ({
      id: r.publicId,
      pluginId: r.connectorId,
      displayName: r.displayName,
      status: toContractStatus(r.status),
      version: resolveConnectorVersion(r.connectorId),
      lastSyncAt: r.lastSyncAt?.toISOString() ?? null,
      entityCount: r.entityCount,
      errorMessage: r.errorMessage ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
    total,
    hasMore: input.offset + rows.length < total,
  };
};
