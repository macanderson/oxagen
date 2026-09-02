import type { CapabilityHandler } from "@oxagen/oxagen";
import { connectionDelete } from "@oxagen/oxagen/contracts/connection.delete";
import { schema, withTenantDb } from "@oxagen/database";
import { eq, and, isNull } from "drizzle-orm";
import { eventClient } from "./event-client";
import { HTTPException } from "hono/http-exception";
import { logger } from "./logger";

export const connectionDeleteHandler: CapabilityHandler<
  typeof connectionDelete
> = async (input, ctx) => {
  if (!ctx.userId) {
    throw new Error("connection.delete requires an authenticated user");
  }

  // Verify connection belongs to this org/workspace and is not already deleted
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
          eq(schema.sourceConnections.publicId, input.connectionId),
          isNull(schema.sourceConnections.deletedAt),
        ),
      )
      .limit(1),
  );

  if (!conn) {
    throw new HTTPException(404, { message: "Connection not found" });
  }

  // Mark the connection as "deleting"
  await withTenantDb((tx) =>
    tx
      .update(schema.sourceConnections)
      .set({ status: "deleting", updatedAt: new Date() })
      .where(eq(schema.sourceConnections.id, conn.id)),
  );

  // Create a deletion job row to track async progress
  const now = new Date();
  const publicId = `djob_${Date.now().toString(36)}`;
  const [job] = await withTenantDb((tx) =>
    tx
      .insert(schema.deletionJobs)
      .values({
        publicId,
        connectionId: conn.id,
        workspaceId: ctx.workspaceId,
        orgId: ctx.orgId,
        deleteMode: input.mode,
        requestedBy: ctx.userId!,
        status: "running",
        startedAt: now,
      })
      .returning({
        id: schema.deletionJobs.id,
        publicId: schema.deletionJobs.publicId,
      }),
  );

  if (!job) throw new Error("connection.delete: failed to create deletion job");

  // Fire Inngest async deletion job. deletionJobId lets the async function
  // finalize THIS exact deletion_jobs row (mark it completed/failed with
  // completed_at) instead of leaving it stuck at status='running' forever.
  await eventClient.send({
    name: "ingestion/connection.delete",
    data: {
      connectionId: conn.id,
      deletionJobId: job.id,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      requestedBy: ctx.userId!,
      mode: input.mode,
      requestedAt: now.toISOString(),
    },
  });

  logger.info(
    {
      connectionId: conn.id,
      deletionJobId: job.id,
      mode: input.mode,
      orgId: ctx.orgId,
    },
    "connection.delete: queued deletion job",
  );

  return {
    deletionJobId: job.publicId,
    mode: input.mode,
    status: "running" as const,
  };
};
