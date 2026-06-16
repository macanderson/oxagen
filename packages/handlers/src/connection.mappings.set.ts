import type { CapabilityHandler } from "@oxagen/oxagen";
import { connectionMappingsSet } from "@oxagen/oxagen/contracts/connection.mappings.set";
import { schema, withTenantDb } from "@oxagen/database";
import { eq, and } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { eventClient } from "./event-client";
import { logger } from "./logger";

export const connectionMappingsSetHandler: CapabilityHandler<typeof connectionMappingsSet> = async (
  input,
  ctx,
) => {
  // Verify connection exists and belongs to this org/workspace
  const [conn] = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.sourceConnections.id,
        status: schema.sourceConnections.status,
        connectorId: schema.sourceConnections.connectorId,
        deliveryConfig: schema.sourceConnections.deliveryConfig,
      })
      .from(schema.sourceConnections)
      .where(
        and(
          eq(schema.sourceConnections.publicId, input.connectionId),
          eq(schema.sourceConnections.orgId, ctx.orgId),
          eq(schema.sourceConnections.workspaceId, ctx.workspaceId),
        ),
      )
      .limit(1),
  );

  if (!conn) throw new HTTPException(404, { message: "Connection not found" });

  let created = 0;
  let updated = 0;
  const now = new Date();

  for (const mapping of input.mappings) {
    // Upsert each mapping: insert new or update existing for this (connection, sourceRecordType)
    const existing = await withTenantDb((tx) =>
      tx
        .select({ id: schema.entityTypeMappings.id })
        .from(schema.entityTypeMappings)
        .where(
          and(
            eq(schema.entityTypeMappings.connectionId, conn.id),
            eq(schema.entityTypeMappings.sourceRecordType, mapping.sourceRecordType),
          ),
        )
        .limit(1),
    );

    if (existing.length > 0 && existing[0]) {
      await withTenantDb((tx) =>
        tx
          .update(schema.entityTypeMappings)
          .set({
            oxagenEntityType: mapping.oxagenEntityType,
            propertyMappings: mapping.propertyMappings,
            isActive: true,
            updatedAt: now,
          })
          .where(eq(schema.entityTypeMappings.id, existing[0]!.id)),
      );
      updated++;
    } else {
      const publicId = `etm_${Date.now().toString(36)}_${mapping.sourceRecordType}`;
      await withTenantDb((tx) =>
        tx.insert(schema.entityTypeMappings).values({
          publicId,
          connectionId: conn.id,
          workspaceId: ctx.workspaceId,
          orgId: ctx.orgId,
          sourceRecordType: mapping.sourceRecordType,
          oxagenEntityType: mapping.oxagenEntityType,
          propertyMappings: mapping.propertyMappings,
          isActive: true,
          createdAt: now,
          updatedAt: now,
        }),
      );
      created++;
    }
  }

  // Activate the connection if requested and currently in pending_setup.
  // "connected" is the live state in the source_connections_status_check
  // constraint (pending_setup | connected | paused | error) — "active" is not
  // a valid value and would fail the CHECK on write.
  let connectionStatus = conn.status;
  if (input.activateConnection && conn.status === "pending_setup") {
    await withTenantDb((tx) =>
      tx
        .update(schema.sourceConnections)
        .set({ status: "connected", updatedAt: now })
        .where(eq(schema.sourceConnections.id, conn.id)),
    );
    connectionStatus = "connected";

    // Fire the GitHub initial-sync Inngest event when activating a GitHub connection.
    // deliveryConfig carries { selectedRepos, installationId, owner, repo, defaultBranch }
    // set by the connection wizard before calling connection.mappings.set.
    if (conn.connectorId === "github") {
      const dc = conn.deliveryConfig as Record<string, unknown> | null;
      const owner = typeof dc?.["owner"] === "string" ? dc["owner"] : "";
      const repo = typeof dc?.["repo"] === "string" ? dc["repo"] : "";
      const defaultBranch =
        typeof dc?.["defaultBranch"] === "string" ? dc["defaultBranch"] : "main";

      await eventClient.send({
        name: "ingestion/github.initial-sync",
        data: {
          connectionId: conn.id,
          orgId: ctx.orgId,
          workspaceId: ctx.workspaceId,
          owner,
          repo,
          defaultBranch,
        },
      });

      logger.info(
        { connectionId: conn.id, owner, repo, orgId: ctx.orgId },
        "connection.mappings.set: fired ingestion/github.initial-sync",
      );
    }
  }

  logger.info(
    {
      connectionId: conn.id,
      created,
      updated,
      connectionStatus,
      orgId: ctx.orgId,
    },
    "connection.mappings.set: saved mappings",
  );

  return { mappingsCreated: created, mappingsUpdated: updated, connectionStatus };
};
