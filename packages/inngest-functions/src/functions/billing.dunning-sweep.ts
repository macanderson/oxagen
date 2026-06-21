import { sweepDunning, isLowBalance, notifyLowBalance } from "@oxagen/billing";
import { withSystemDb, schema } from "@oxagen/database";
import { and, asc, eq, gt } from "drizzle-orm";
import { createFunction } from "../create-function";
import { logger } from "../logger";

// Keyset-pagination page size for the active-org low-balance scan. Bounds the
// heap slice loaded per step and keeps each step.run() well under Inngest's
// per-step timeout even with a large tenant fleet.
const LOW_BALANCE_PAGE_SIZE = 500;

/**
 * Daily sweep: move any orgs still in 'grace' whose graceEndsAt has elapsed
 * to 'suspended'. Also checks active orgs for low balance and sends alert
 * notifications. Runs at 02:00 UTC daily.
 *
 * sweepDunning() is idempotent — safe to retry on Inngest failure. Returns
 * a count of orgs suspended in this run.
 */
export const [billingDunningSweep] = createFunction(
  { id: "billing.dunning-sweep", retries: 3 },
  { cron: "0 2 * * *" },
  async ({ step }) => {
    const result = await step.run("sweep", async () => {
      return await sweepDunning();
    });

    // Check active orgs for low balance and notify managers. Paginated by
    // keyset on orgId (unique index) so neither the DB load nor the per-org
    // fan-out is unbounded; each page is its own checkpointed step.run so a
    // timeout on one page never aborts the whole sweep mid-flight.
    let notified = 0;
    let cursor: string | null = null;
    let page = 0;
    for (;;) {
      const cursorForPage: string | null = cursor;
      const result = await step.run(
        `low-balance-page-${page}`,
        async (): Promise<{ count: number; nextCursor: string | null }> => {
        const activeOrgs = await withSystemDb((tx) =>
          tx.query.orgBillingSettings.findMany({
            where: cursorForPage
              ? and(
                  eq(schema.orgBillingSettings.dunningState, "active"),
                  gt(schema.orgBillingSettings.orgId, cursorForPage),
                )
              : eq(schema.orgBillingSettings.dunningState, "active"),
            columns: { orgId: true },
            orderBy: [asc(schema.orgBillingSettings.orgId)],
            limit: LOW_BALANCE_PAGE_SIZE,
          }),
        );

        let count = 0;
        for (const { orgId } of activeOrgs) {
          try {
            const balanceResult = await isLowBalance(orgId);
            if (balanceResult.low) {
              await notifyLowBalance(orgId, balanceResult);
              count++;
            }
          } catch (err) {
            logger.warn(
              { orgId, err },
              "billing.dunning-sweep: low-balance check failed for org (non-fatal)",
            );
          }
        }

        const nextCursor =
          activeOrgs.length === LOW_BALANCE_PAGE_SIZE
            ? (activeOrgs[activeOrgs.length - 1]?.orgId ?? null)
            : null;
        return { count, nextCursor };
      },
      );

      notified += result.count;
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
      page++;
    }

    logger.info({ suspended: result.suspended, lowBalanceNotified: notified }, "billing.dunning-sweep complete");
    return { ...result, lowBalanceNotified: notified };
  },
);
