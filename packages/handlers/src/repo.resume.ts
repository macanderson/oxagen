import type { CapabilityHandler } from "@oxagen/oxagen";
import { repoResume } from "@oxagen/oxagen/contracts/repo.resume";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import type { DeliveryConfig } from "@oxagen/ingestion/filters";
import { sourceConnectionRefCondition } from "./lib/connection-status";
import { logger } from "./logger";

/**
 * repo.resume — resume automatic syncing for a paused repository connection by
 * setting its `source_connections.status` back to 'connected' (the DB live
 * state; the contract exposes this as 'active'). Only valid from the 'paused'
 * or (idempotently) 'connected' states.
 *
 * nextSyncAt is computed only for polling connections — now + syncIntervalSeconds
 * — since that is when the Inngest poll cron will next pick the connection up.
 * Webhook / manual connections have no scheduled sync, so nextSyncAt is null.
 */
export const repoResumeHandler: CapabilityHandler<typeof repoResume> = async (
  input,
  ctx,
) => {
  const now = new Date();

  const found = await withTenantDb(async (tx) => {
    const [existing] = await tx
      .select({
        id: schema.sourceConnections.id,
        status: schema.sourceConnections.status,
        deliveryMethod: schema.sourceConnections.deliveryMethod,
        deliveryConfig: schema.sourceConnections.deliveryConfig,
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

    if (existing.status !== "paused" && existing.status !== "connected") {
      throw new HTTPException(409, {
        message: `Repository connection is '${existing.status}' — only paused/connected connections can be resumed`,
      });
    }

    await tx
      .update(schema.sourceConnections)
      .set({
        status: "connected",
        updatedByUserId: ctx.userId ?? undefined,
        updatedAt: now,
      })
      .where(eq(schema.sourceConnections.id, existing.id));

    return existing;
  });

  if (!found) {
    logger.warn(
      { repoId: input.repoId, orgId: ctx.orgId },
      "repo.resume: not found",
    );
    throw new HTTPException(404, {
      message: "Repository connection not found",
    });
  }

  const deliveryConfig = (found.deliveryConfig ?? {}) as DeliveryConfig;
  const syncMethod =
    deliveryConfig.syncMethod ?? found.deliveryMethod ?? "manual";
  const nextSyncAt =
    syncMethod === "polling"
      ? new Date(
          now.getTime() + (deliveryConfig.syncIntervalSeconds ?? 300) * 1000,
        ).toISOString()
      : null;

  logger.info(
    {
      repoId: input.repoId,
      connectionId: found.id,
      syncMethod,
      orgId: ctx.orgId,
      surface: ctx.surface,
    },
    "repo.resume: resumed",
  );

  return {
    repoId: input.repoId,
    status: "active" as const,
    resumedAt: now.toISOString(),
    nextSyncAt,
  };
};
