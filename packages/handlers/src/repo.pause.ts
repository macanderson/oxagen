import type { CapabilityHandler } from "@oxagen/oxagen";
import { repoPause } from "@oxagen/oxagen/contracts/repo.pause";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { sourceConnectionRefCondition } from "./lib/connection-status";
import { logger } from "./logger";

/**
 * repo.pause — pause automatic syncing for a repository connection by setting
 * its `source_connections.status` to 'paused'. Only valid from the 'connected'
 * or (idempotently) 'paused' states; a pending_setup / error / deleting
 * connection cannot be paused. The next scheduled Inngest sync skips paused
 * connections, so no explicit cron cancellation is required here. Tenant-scoped
 * and soft-delete aware; accepts the public ID or the UUID.
 */
export const repoPauseHandler: CapabilityHandler<typeof repoPause> = async (
  input,
  ctx,
) => {
  const now = new Date();

  const found = await withTenantDb(async (tx) => {
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
          sourceConnectionRefCondition(input.repoId),
          isNull(schema.sourceConnections.deletedAt),
        ),
      )
      .limit(1);

    if (!existing) return null;

    if (existing.status !== "connected" && existing.status !== "paused") {
      throw new HTTPException(409, {
        message: `Repository connection is '${existing.status}' — only connected/paused connections can be paused`,
      });
    }

    await tx
      .update(schema.sourceConnections)
      .set({
        status: "paused",
        updatedByUserId: ctx.userId ?? undefined,
        updatedAt: now,
      })
      .where(eq(schema.sourceConnections.id, existing.id));

    return existing;
  });

  if (!found) {
    logger.warn(
      { repoId: input.repoId, orgId: ctx.orgId },
      "repo.pause: not found",
    );
    throw new HTTPException(404, {
      message: "Repository connection not found",
    });
  }

  logger.info(
    {
      repoId: input.repoId,
      connectionId: found.id,
      orgId: ctx.orgId,
      surface: ctx.surface,
    },
    "repo.pause: paused",
  );

  return {
    repoId: input.repoId,
    status: "paused" as const,
    pausedAt: now.toISOString(),
  };
};
