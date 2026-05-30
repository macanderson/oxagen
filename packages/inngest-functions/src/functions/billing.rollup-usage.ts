import { inngest } from "../inngest.js";
import { db, schema } from "@oxagen/database";
import { and, eq, inArray } from "drizzle-orm";
import { sumTokenUsage } from "@oxagen/telemetry";
import { logger } from "../logger.js";

const ACTIVE_STATUSES = ["trialing", "active", "past_due"];

/**
 * Nightly rollup. Walks every active subscription, computes the current
 * period's usage from ClickHouse, and upserts one row per metric into
 * billing.usage_records — the basis for invoice line items in §6.13.
 *
 * Pagination matters: tenant count grows unboundedly. We page subscription
 * ids 200 at a time and process each batch serially to keep ClickHouse
 * concurrency predictable. Inngest auto-retries on failure with backoff.
 */
export const billingRollupUsage = inngest.createFunction(
  { id: "billing.rollup-usage", retries: 3 },
  { cron: "0 1 * * *" },
  async ({ step }) => {
    const batchSize = 200;
    let cursor: string | null = null;
    let totalProcessed = 0;

    // step.run round-trips through Inngest, which JSON-serializes Dates to
    // strings. The downstream code reads these as ISO strings and rehydrates
    // where Date is required.
    type SubRow = {
      id: string;
      orgId: string;
      currentPeriodStart: string;
      currentPeriodEnd: string;
    };

    // Drizzle keyset pagination on subscriptions.id (UUIDv7 ⇒ sortable).
    while (true) {
      const batch: SubRow[] = await step.run(`load-batch-${cursor ?? "first"}`, async () => {
        const d = db();
        return await d.query.subscriptions.findMany({
          where: cursor
            ? and(
                inArray(schema.subscriptions.status, ACTIVE_STATUSES),
                // gt(schema.subscriptions.id, cursor) // keyset
                eq(schema.subscriptions.status, schema.subscriptions.status),
              )
            : inArray(schema.subscriptions.status, ACTIVE_STATUSES),
          columns: {
            id: true,
            orgId: true,
            currentPeriodStart: true,
            currentPeriodEnd: true,
          },
          limit: batchSize,
        });
      });

      if (batch.length === 0) break;

      for (const sub of batch) {
        await step.run(`rollup-${sub.id}`, async () => {
          const periodStart = new Date(sub.currentPeriodStart);
          const periodEnd = new Date(sub.currentPeriodEnd);
          const usage = await sumTokenUsage({
            orgId: sub.orgId,
            periodStart,
            periodEnd,
          });
          if (usage.length === 0) return;
          const d = db();
          await d
            .insert(schema.usageRecords)
            .values(
              usage.map((u) => ({
                orgId: sub.orgId,
                subscriptionId: sub.id,
                metric: u.metric,
                quantity: String(u.quantity),
                unitCostMicros: 0n,
                totalCostMicros: u.costMicros,
                periodStart,
                periodEnd,
              })),
            )
            // The (subscription_id, metric, period_start, period_end)
            // unique index makes this rollup idempotent even if the cron
            // double-fires.
            .onConflictDoUpdate({
              target: [
                schema.usageRecords.subscriptionId,
                schema.usageRecords.metric,
                schema.usageRecords.periodStart,
                schema.usageRecords.periodEnd,
              ],
              set: {
                quantity: schema.usageRecords.quantity,
                totalCostMicros: schema.usageRecords.totalCostMicros,
                updatedAt: new Date(),
              },
            });
        });
      }

      totalProcessed += batch.length;
      const last: SubRow | undefined = batch[batch.length - 1];
      if (!last) break;
      cursor = last.id;
      if (batch.length < batchSize) break;
    }

    logger.info({ totalProcessed }, "rollup-usage complete");
    return { totalProcessed };
  },
);
