import { inngest } from "../inngest";
import { db, schema } from "@oxagen/database";
import { and, gt, inArray } from "drizzle-orm";
import { sumTokenUsage } from "@oxagen/telemetry";
import { logger } from "../logger";

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
      const batchRaw = await step.run(`load-batch-${cursor ?? "first"}`, async () => {
        const d = db();
        const rows = await d.query.subscriptions.findMany({
          where: cursor
            ? and(
                inArray(schema.subscriptions.status, ACTIVE_STATUSES),
                // Keyset: only rows after the last id processed. Paired with the
                // id ordering below this advances every batch — a no-op
                // predicate here re-fetches page 1 forever (infinite loop).
                gt(schema.subscriptions.id, cursor),
              )
            : inArray(schema.subscriptions.status, ACTIVE_STATUSES),
          columns: {
            id: true,
            orgId: true,
            currentPeriodStart: true,
            currentPeriodEnd: true,
          },
          // Keyset pagination needs a deterministic order on the cursor column;
          // without it `cursor = last.id` is meaningless and pages can repeat.
          orderBy: (subscriptions, { asc }) => [asc(subscriptions.id)],
          limit: batchSize,
        });
        // Columns are NOT NULL in the schema (billing.ts:34-41); the ?? guards
        // only bridge Drizzle's select-result optionality.
        return rows.map((row) => ({
          id: row.id ?? "",
          orgId: row.orgId ?? "",
          currentPeriodStart: row.currentPeriodStart?.toISOString() ?? "",
          currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? "",
        }));
      });
      // step.run wraps its result in Inngest's JsonifyObject, which Vercel's
      // declaration-emit tsc infers with all properties optional (local tsc keeps
      // them required). Re-pin to SubRow OUTSIDE step.run — no wrapper here — so
      // `batch: SubRow[]` holds unconditionally.
      const batch: SubRow[] = batchRaw.map((r) => ({
        id: r.id ?? "",
        orgId: r.orgId ?? "",
        currentPeriodStart: r.currentPeriodStart ?? "",
        currentPeriodEnd: r.currentPeriodEnd ?? "",
      }));

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
