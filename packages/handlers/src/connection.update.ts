import type { CapabilityHandler } from "@oxagen/oxagen";
import { connectionUpdate } from "@oxagen/oxagen/contracts/connection.update";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { logger } from "./logger";
import { assertGithubInstallationAccessible } from "./lib/github-installation-access";

// Rename / re-configure a source connection. Tenant-scoped (org + workspace),
// soft-delete aware. Partial: only provided fields change. Kernel meters + IAM.
export const connectionUpdateHandler: CapabilityHandler<
  typeof connectionUpdate
> = async (input, ctx) => {
  const updates: Record<string, unknown> = {
    updatedByUserId: ctx.userId ?? undefined,
  };
  if (input.displayName !== undefined) updates.displayName = input.displayName;
  if (input.deliveryConfig !== undefined)
    updates.deliveryConfig = input.deliveryConfig;

  // AUTHORIZATION GATE (github): deliveryConfig is a wholesale overwrite, so a
  // client could set/replace installationId here. If this is a GitHub connection
  // and the incoming deliveryConfig carries an installationId, verify the acting
  // user can reach it before trusting it (see connection.mappings.set).
  if (input.deliveryConfig !== undefined) {
    const iid = (input.deliveryConfig as Record<string, unknown> | null)?.[
      "installationId"
    ];
    if (typeof iid === "string" || typeof iid === "number") {
      const [target] = await withTenantDb((tx) =>
        tx
          .select({ connectorId: schema.sourceConnections.connectorId })
          .from(schema.sourceConnections)
          .where(
            and(
              eq(schema.sourceConnections.orgId, ctx.orgId),
              eq(schema.sourceConnections.workspaceId, ctx.workspaceId),
              eq(schema.sourceConnections.publicId, input.connectionId),
              isNull(schema.sourceConnections.deletedAt),
            ),
          )
          .limit(1),
      );
      if (target?.connectorId === "github") {
        await assertGithubInstallationAccessible(ctx, iid);
      }
    }
  }

  const row = await withTenantDb(async (tx) => {
    if (Object.keys(updates).length > 1) {
      await tx
        .update(schema.sourceConnections)
        .set({ ...updates, updatedAt: new Date() })
        .where(
          and(
            eq(schema.sourceConnections.orgId, ctx.orgId),
            eq(schema.sourceConnections.workspaceId, ctx.workspaceId),
            eq(schema.sourceConnections.publicId, input.connectionId),
            isNull(schema.sourceConnections.deletedAt),
          ),
        );
    }
    const [r] = await tx
      .select({
        publicId: schema.sourceConnections.publicId,
        displayName: schema.sourceConnections.displayName,
        status: schema.sourceConnections.status,
        deliveryConfig: schema.sourceConnections.deliveryConfig,
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
    return r ?? null;
  });

  if (!row) {
    logger.warn(
      { connectionId: input.connectionId, orgId: ctx.orgId },
      "connection.update: not found",
    );
    throw new HTTPException(404, { message: "Connection not found" });
  }

  logger.info(
    {
      connectionId: input.connectionId,
      orgId: ctx.orgId,
      surface: ctx.surface,
    },
    "connection.update: updated",
  );

  return {
    connectionId: row.publicId,
    displayName: row.displayName,
    status: row.status,
    deliveryConfig:
      (row.deliveryConfig as Record<string, unknown> | null) ?? null,
  };
};
