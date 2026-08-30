import type { CapabilityHandler } from "@oxagen/oxagen";
import { integrationSync } from "@oxagen/oxagen/contracts/integration.sync";
import { schema, withTenantDb } from "@oxagen/database";
import { eq, and, isNull } from "drizzle-orm";
import { eventClient } from "./event-client";
import type { DeliveryConfig } from "@oxagen/ingestion/filters";
import { logger } from "./logger";

/**
 * integration.sync handler.
 *
 * 1. Reads the source connection from Postgres to resolve the connection UUID
 *    from the public integrationId.
 * 2. Reads deliveryConfig for the connection's sync method and interval.
 * 3. Sends one "ingestion/sync.requested" Inngest event carrying that context.
 * 4. Returns the job ID and queued status.
 *
 * The handler does NOT branch on sync method — polling, webhook and manual all
 * produce the same one-off event, and the receiving Inngest function decides
 * what to do with `syncMethod`/`syncIntervalSeconds`. The recurring polling
 * cadence is owned separately by an Inngest cron function (registered in
 * @oxagen/inngest-functions); this capability is the on-demand trigger.
 *
 * The handler also does not gate on `sourceConnections.status`, so a paused or
 * errored connection can still be asked to sync.
 */
export const integrationSyncHandler: CapabilityHandler<
  typeof integrationSync
> = async (input, ctx) => {
  // Resolve source connection by public ID
  const [row] = await withTenantDb((tx) =>
    tx
      .select({
        id: schema.sourceConnections.id,
        deliveryMethod: schema.sourceConnections.deliveryMethod,
        deliveryConfig: schema.sourceConnections.deliveryConfig,
        status: schema.sourceConnections.status,
      })
      .from(schema.sourceConnections)
      .where(
        and(
          eq(schema.sourceConnections.publicId, input.integrationId),
          eq(schema.sourceConnections.orgId, ctx.orgId),
          eq(schema.sourceConnections.workspaceId, ctx.workspaceId),
          isNull(schema.sourceConnections.deletedAt),
        ),
      )
      .limit(1),
  );

  if (!row) {
    throw new Error(
      `integration.sync: integration not found: ${input.integrationId}`,
    );
  }

  const deliveryConfig = (row.deliveryConfig ?? {}) as DeliveryConfig;
  const syncMethod =
    deliveryConfig.syncMethod ?? row.deliveryMethod ?? "manual";
  const syncIntervalSeconds = deliveryConfig.syncIntervalSeconds ?? 300;

  const jobId = "job_" + crypto.randomUUID();

  // Queue the sync job via Inngest. The event carries sync-method context so
  // the receiving function can apply the correct cadence and backoff strategy.
  await eventClient.send({
    name: "ingestion/sync.requested",
    data: {
      jobId,
      connectionId: row.id,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      integrationId: input.integrationId,
      mode: input.mode,
      syncMethod,
      syncIntervalSeconds,
      requestedAt: new Date().toISOString(),
    },
  });

  logger.info(
    {
      jobId,
      integrationId: input.integrationId,
      connectionId: row.id,
      mode: input.mode,
      syncMethod,
      syncIntervalSeconds:
        syncMethod === "polling" ? syncIntervalSeconds : undefined,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
    },
    "integration.sync: queued",
  );

  return {
    jobId,
    status: "queued" as const,
    integrationId: input.integrationId,
    mode: input.mode,
  };
};
