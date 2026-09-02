import type { CapabilityHandler } from "@oxagen/oxagen";
import { connectionPause } from "@oxagen/oxagen/contracts/connection.pause";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { logger } from "./logger";

// Pause / resume ingestion for a source connection by toggling its status
// between 'connected' and 'paused'. Only valid from those two states — a
// pending_setup or error connection cannot be paused/resumed (must be set up or
// repaired first). Tenant-scoped, soft-delete aware.
export const connectionPauseHandler: CapabilityHandler<
  typeof connectionPause
> = async (input, ctx) => {
  const target = input.paused ? "paused" : "connected";

  const row = await withTenantDb(async (tx) => {
    const [existing] = await tx
      .select({
        id: schema.sourceConnections.id,
        status: schema.sourceConnections.status,
      })
      .from(schema.sourceConnections)
      .where(
        and(
          eq(schema.sourceConnections.orgId, ctx.orgId),
          eq(schema.sourceConnections.workspaceId, ctx.workspaceId),
          eq(schema.sourceConnections.publicId, input.connectionId),
          isNull(schema.sourceConnections.deletedAt),
        ),
      )
      .limit(1);

    if (!existing) return null;

    if (existing.status !== "connected" && existing.status !== "paused") {
      throw new HTTPException(409, {
        message: `Connection is '${existing.status}' — only connected/paused connections can be paused or resumed`,
      });
    }

    await tx
      .update(schema.sourceConnections)
      .set({
        status: target,
        updatedByUserId: ctx.userId ?? undefined,
        updatedAt: new Date(),
      })
      .where(eq(schema.sourceConnections.id, existing.id));

    return existing;
  });

  if (!row) {
    logger.warn(
      { connectionId: input.connectionId, orgId: ctx.orgId },
      "connection.pause: not found",
    );
    throw new HTTPException(404, { message: "Connection not found" });
  }

  logger.info(
    {
      connectionId: input.connectionId,
      orgId: ctx.orgId,
      target,
      surface: ctx.surface,
    },
    "connection.pause: status updated",
  );

  return { connectionId: input.connectionId, status: target };
};
