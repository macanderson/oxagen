import type { CapabilityHandler } from "@oxagen/oxagen";
import { connectionList } from "@oxagen/oxagen/contracts/connection.list";
import { schema, withTenantDb } from "@oxagen/database";
import { eq, and, isNull } from "drizzle-orm";
import { logger } from "./logger";

export const connectionListHandler: CapabilityHandler<
  typeof connectionList
> = async (input, ctx) => {
  const rows = await withTenantDb((tx) => {
    const conditions = [
      eq(schema.sourceConnections.orgId, ctx.orgId),
      eq(schema.sourceConnections.workspaceId, ctx.workspaceId),
      isNull(schema.sourceConnections.deletedAt),
    ];
    if (input.status) {
      conditions.push(eq(schema.sourceConnections.status, input.status));
    }
    if (input.connectorId) {
      conditions.push(
        eq(schema.sourceConnections.connectorId, input.connectorId),
      );
    }
    return tx
      .select({
        id: schema.sourceConnections.id,
        publicId: schema.sourceConnections.publicId,
        connectorId: schema.sourceConnections.connectorId,
        displayName: schema.sourceConnections.displayName,
        authScheme: schema.sourceConnections.authScheme,
        deliveryMethod: schema.sourceConnections.deliveryMethod,
        status: schema.sourceConnections.status,
        entityCount: schema.sourceConnections.entityCount,
        lastSyncAt: schema.sourceConnections.lastSyncAt,
        healthStatus: schema.sourceConnections.healthStatus,
        lastPollAt: schema.sourceConnections.lastPollAt,
        nextPollAt: schema.sourceConnections.nextPollAt,
        createdAt: schema.sourceConnections.createdAt,
      })
      .from(schema.sourceConnections)
      .where(and(...conditions))
      .orderBy(schema.sourceConnections.createdAt);
  });

  logger.info(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId, count: rows.length },
    "connection.list: fetched connections",
  );

  return {
    connections: rows.map((r) => ({
      ...r,
      lastSyncAt: r.lastSyncAt?.toISOString() ?? null,
      healthStatus:
        (r.healthStatus as "healthy" | "degraded" | "errored") ?? "healthy",
      lastPollAt: r.lastPollAt?.toISOString() ?? null,
      nextPollAt: r.nextPollAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    })),
  };
};
