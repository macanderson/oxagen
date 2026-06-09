import type { CapabilityHandler } from "@oxagen/oxagen";
import { connectionMappingsSet } from "@oxagen/oxagen/contracts/connection.mappings.set";
import { schema, withTenantDb } from "@oxagen/database";
import { eq, and } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { logger } from "./logger";

export const connectionMappingsSetHandler: CapabilityHandler<typeof connectionMappingsSet> = async (
  input,
  ctx,
) => {
  // Verify connection exists and belongs to this org/workspace
  const [conn] = await withTenantDb((tx) =>
    tx
      .select({ id: schema.sourceConnections.id, status: schema.sourceConnections.status })
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

  // Activate the connection if requested and currently in pending_setup
  let connectionStatus = conn.status;
  if (input.activateConnection && conn.status === "pending_setup") {
    await withTenantDb((tx) =>
      tx
        .update(schema.sourceConnections)
        .set({ status: "active", updatedAt: now })
        .where(eq(schema.sourceConnections.id, conn.id)),
    );
    connectionStatus = "active";
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
