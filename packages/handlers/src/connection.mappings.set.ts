import type { CapabilityHandler } from "@oxagen/oxagen";
import { connectionMappingsSet } from "@oxagen/oxagen/contracts/connection.mappings.set";
import { schema, withTenantDb } from "@oxagen/database";
import { eq, and, inArray } from "drizzle-orm";
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

  const now = new Date();

  // "connected" is the live state in the source_connections_status_check
  // constraint (pending_setup | connected | paused | error) — "active" is not
  // a valid value and would fail the CHECK on write.
  const willActivate = input.activateConnection && conn.status === "pending_setup";

  // Upsert every mapping AND (optionally) the connection status flip inside a
  // single tenant-scoped transaction. This is atomic — a mid-batch failure
  // rolls back every write — and collapses the previous O(N) round-trips
  // (one SELECT + one INSERT/UPDATE per mapping) into a fixed two-query batch.
  const { created, updated } = await withTenantDb(async (tx) => {
    // One batched lookup of all existing mappings for this connection that
    // collide with the incoming source record types, instead of one SELECT
    // per mapping.
    const sourceTypes = input.mappings.map((m) => m.sourceRecordType);
    const existingRows = sourceTypes.length
      ? await tx
          .select({
            id: schema.entityTypeMappings.id,
            sourceRecordType: schema.entityTypeMappings.sourceRecordType,
          })
          .from(schema.entityTypeMappings)
          .where(
            and(
              eq(schema.entityTypeMappings.connectionId, conn.id),
              inArray(schema.entityTypeMappings.sourceRecordType, sourceTypes),
            ),
          )
      : [];

    const existingByType = new Map(existingRows.map((r) => [r.sourceRecordType, r.id]));

    let createdCount = 0;
    let updatedCount = 0;

    for (const mapping of input.mappings) {
      const existingId = existingByType.get(mapping.sourceRecordType);
      if (existingId) {
        await tx
          .update(schema.entityTypeMappings)
          .set({
            oxagenEntityType: mapping.oxagenEntityType,
            propertyMappings: mapping.propertyMappings,
            isActive: true,
            updatedAt: now,
          })
          .where(eq(schema.entityTypeMappings.id, existingId));
        updatedCount++;
      } else {
        const publicId = `etm_${Date.now().toString(36)}_${mapping.sourceRecordType}`;
        await tx.insert(schema.entityTypeMappings).values({
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
        });
        createdCount++;
      }
    }

    // Activate the connection if requested and currently in pending_setup —
    // in the same transaction so mappings + status flip commit together.
    // Also merge any delivery config fields supplied by the caller (owner,
    // repo, defaultBranch, installationId, syncDepthDays, selectedRepos)
    // into the stored deliveryConfig. Merging in the same tx ensures the
    // config is always consistent with the activation status.
    if (willActivate) {
      const existingDc = (conn.deliveryConfig ?? {}) as Record<string, unknown>;
      const mergedDc: Record<string, unknown> = { ...existingDc };
      if (input.owner !== undefined) mergedDc["owner"] = input.owner;
      if (input.repo !== undefined) mergedDc["repo"] = input.repo;
      if (input.defaultBranch !== undefined) mergedDc["defaultBranch"] = input.defaultBranch;
      if (input.installationId !== undefined) mergedDc["installationId"] = input.installationId;
      if (input.syncDepthDays !== undefined) mergedDc["syncDepthDays"] = input.syncDepthDays;
      if (input.selectedRepos !== undefined) mergedDc["selectedRepos"] = input.selectedRepos;

      await tx
        .update(schema.sourceConnections)
        .set({ status: "connected", deliveryConfig: mergedDc, updatedAt: now })
        .where(eq(schema.sourceConnections.id, conn.id));

      // Expose merged config so the post-tx Inngest event uses the fresh values.
      conn.deliveryConfig = mergedDc;
    }

    return { created: createdCount, updated: updatedCount };
  });

  let connectionStatus = conn.status;
  if (willActivate) {
    connectionStatus = "connected";

    // Fire the GitHub initial-sync Inngest event when activating a GitHub
    // connection — after the transaction commits, never inside it.
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
