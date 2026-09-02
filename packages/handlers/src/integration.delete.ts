import type { CapabilityHandler } from "@oxagen/oxagen";
import { integrationDelete } from "@oxagen/oxagen/contracts/integration.delete";
import { schema, withTenantDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { HTTPException } from "hono/http-exception";
import { eventClient } from "./event-client";
import { logger } from "./logger";

/**
 * integration.delete — remove an integration instance (an
 * `ingestion.source_connections` row) and optionally purge its graph data from
 * Neo4j. Mirrors connection.delete: flips the connection to 'deleting', records
 * a deletion_jobs row to track async progress, and fires the
 * `ingestion/connection.delete` Inngest job which performs the soft-delete +
 * optional Neo4j purge.
 *
 * purgeData → delete mode: true purges entities/edges from Neo4j ("full"),
 * false removes only the connection record ("connection_only").
 */
export const integrationDeleteHandler: CapabilityHandler<
  typeof integrationDelete
> = async (input, ctx) => {
  if (!ctx.userId) {
    throw new HTTPException(401, {
      message: "integration.delete requires an authenticated user",
    });
  }

  const mode = input.purgeData ? "full" : "connection_only";

  const [conn] = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.sourceConnections.id,
        status: schema.sourceConnections.status,
      })
      .from(schema.sourceConnections)
      .where(
        and(
          eq(schema.sourceConnections.orgId, ctx.orgId),
          eq(schema.sourceConnections.workspaceId, ctx.workspaceId),
          eq(schema.sourceConnections.publicId, input.integrationId),
          isNull(schema.sourceConnections.deletedAt),
        ),
      )
      .limit(1),
  );

  if (!conn) {
    logger.warn(
      { integrationId: input.integrationId, orgId: ctx.orgId },
      "integration.delete: not found",
    );
    throw new HTTPException(404, { message: "Integration not found" });
  }

  // Flip to 'deleting' so the UI and other surfaces stop treating it as live.
  await withTenantDb((tx) =>
    tx
      .update(schema.sourceConnections)
      .set({
        status: "deleting",
        updatedByUserId: ctx.userId ?? undefined,
        updatedAt: new Date(),
      })
      .where(eq(schema.sourceConnections.id, conn.id)),
  );

  const now = new Date();
  const publicId = `djob_${now.getTime().toString(36)}`;
  const [job] = await withTenantDb((tx) =>
    tx
      .insert(schema.deletionJobs)
      .values({
        publicId,
        connectionId: conn.id,
        workspaceId: ctx.workspaceId,
        orgId: ctx.orgId,
        deleteMode: mode,
        requestedBy: ctx.userId!,
        status: "running",
        startedAt: now,
      })
      .returning({
        id: schema.deletionJobs.id,
        publicId: schema.deletionJobs.publicId,
      }),
  );

  if (!job)
    throw new Error("integration.delete: failed to create deletion job");

  await eventClient.send({
    name: "ingestion/connection.delete",
    data: {
      connectionId: conn.id,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      requestedBy: ctx.userId!,
      mode,
      requestedAt: now.toISOString(),
    },
  });

  logger.info(
    {
      jobId: job.publicId,
      integrationId: input.integrationId,
      connectionId: conn.id,
      mode,
      purgeData: input.purgeData,
      orgId: ctx.orgId,
    },
    "integration.delete: queued deletion job",
  );

  return {
    jobId: job.publicId,
    status: "queued" as const,
    integrationId: input.integrationId,
    purgeData: input.purgeData,
  };
};
