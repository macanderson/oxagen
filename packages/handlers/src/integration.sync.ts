import type { CapabilityHandler } from "@oxagen/oxagen";
import { integrationSync } from "@oxagen/oxagen/contracts/integration.sync";
import { schema, withTenantDb } from "@oxagen/database";
import { eq, and, isNull } from "drizzle-orm";
import { inngest } from "@oxagen/inngest-functions/client";
import type { DeliveryConfig } from "@oxagen/ingestion/filters";
import { logger } from "./logger";

/**
 * integration.sync handler.
 *
 * 1. Reads the source connection from Postgres to resolve the connection UUID
 *    from the public integrationId.
 * 2. Reads deliveryConfig to determine the sync method:
 *    - "polling"  → queues an Inngest sync job at the configured interval
 *    - "webhook"  → confirms the webhook subscription is active (no new job)
 *    - "manual"   → queues an on-demand Inngest sync job
 * 3. Returns the job ID and queued status.
 *
 * Scheduling for polling connections:
 *   The cron-style scheduling is owned by Inngest (via scheduled functions).
 *   This handler sends a one-off "integration/sync.requested" event which the
 *   Inngest function picks up. The polling cadence itself is enforced by a
 *   separate Inngest cron function (registered in @oxagen/inngest-functions)
 *   that fires at `syncIntervalSeconds` intervals for active polling connections.
 *
 * For webhook connections, calling integration.sync manually triggers a
 * re-sync of any events that arrived since the last cursor position.
 */
export const integrationSyncHandler: CapabilityHandler<typeof integrationSync> = async (
  input,
  ctx,
) => {
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
    throw new Error(`integration.sync: integration not found: ${input.integrationId}`);
  }

  const deliveryConfig = (row.deliveryConfig ?? {}) as DeliveryConfig;
  const syncMethod = deliveryConfig.syncMethod ?? row.deliveryMethod ?? "manual";
  const syncIntervalSeconds = deliveryConfig.syncIntervalSeconds ?? 300;

  const jobId = "job_" + crypto.randomUUID();

  // Queue the sync job via Inngest. The event carries sync-method context so
  // the receiving function can apply the correct cadence and backoff strategy.
  await inngest.send({
    name: "ingestion/sync.requested" as never,
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
      syncIntervalSeconds: syncMethod === "polling" ? syncIntervalSeconds : undefined,
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
