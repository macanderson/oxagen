import type { CapabilityHandler } from "@oxagen/oxagen";
import { connectionGet } from "@oxagen/oxagen/contracts/connection.get";
import { schema, withTenantDb } from "@oxagen/database";
import { eq, and, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { logger } from "./logger";

export const connectionGetHandler: CapabilityHandler<
  typeof connectionGet
> = async (input, ctx) => {
  const [row] = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.sourceConnections.id,
        publicId: schema.sourceConnections.publicId,
        connectorId: schema.sourceConnections.connectorId,
        displayName: schema.sourceConnections.displayName,
        authScheme: schema.sourceConnections.authScheme,
        deliveryMethod: schema.sourceConnections.deliveryMethod,
        deliveryConfig: schema.sourceConnections.deliveryConfig,
        status: schema.sourceConnections.status,
        entityCount: schema.sourceConnections.entityCount,
        lastSyncAt: schema.sourceConnections.lastSyncAt,
        errorMessage: schema.sourceConnections.errorMessage,
        healthStatus: schema.sourceConnections.healthStatus,
        consecutiveFailureCount:
          schema.sourceConnections.consecutiveFailureCount,
        lastPollAt: schema.sourceConnections.lastPollAt,
        nextPollAt: schema.sourceConnections.nextPollAt,
        lastErrorAt: schema.sourceConnections.lastErrorAt,
        createdAt: schema.sourceConnections.createdAt,
        updatedAt: schema.sourceConnections.updatedAt,
      })
      .from(schema.sourceConnections)
      .where(
        and(
          eq(schema.sourceConnections.orgId, ctx.orgId),
          eq(schema.sourceConnections.workspaceId, ctx.workspaceId),
          isNull(schema.sourceConnections.deletedAt),
          // support both UUID and public_id lookup
          eq(schema.sourceConnections.publicId, input.connectionId),
        ),
      )
      .limit(1),
  );

  if (!row) {
    logger.warn(
      { connectionId: input.connectionId, orgId: ctx.orgId },
      "connection.get: not found",
    );
    throw new HTTPException(404, { message: "Connection not found" });
  }

  return {
    ...row,
    deliveryConfig:
      (row.deliveryConfig as Record<string, unknown> | null) ?? null,
    lastSyncAt: row.lastSyncAt?.toISOString() ?? null,
    healthStatus:
      (row.healthStatus as "healthy" | "degraded" | "errored") ?? "healthy",
    lastPollAt: row.lastPollAt?.toISOString() ?? null,
    nextPollAt: row.nextPollAt?.toISOString() ?? null,
    lastErrorAt: row.lastErrorAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
};
