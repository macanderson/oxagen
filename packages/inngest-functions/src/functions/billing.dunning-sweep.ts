import { inngest } from "../inngest";
import { sweepDunning, isLowBalance, notifyLowBalance } from "@oxagen/billing";
import { withSystemDb, schema } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { logger } from "../logger";

/**
 * Daily sweep: move any orgs still in 'grace' whose graceEndsAt has elapsed
 * to 'suspended'. Also checks active orgs for low balance and sends alert
 * notifications. Runs at 02:00 UTC daily.
 *
 * sweepDunning() is idempotent — safe to retry on Inngest failure. Returns
 * a count of orgs suspended in this run.
 */
export const billingDunningSweep = inngest.createFunction(
  { id: "billing.dunning-sweep", retries: 3 },
  { cron: "0 2 * * *" },
  async ({ step }) => {
    const result = await step.run("sweep", async () => {
      return await sweepDunning();
    });

    // Check active orgs for low balance and notify managers.
    const notified = await step.run("low-balance-check", async () => {
      const activeOrgs = await withSystemDb((tx) =>
        tx.query.orgBillingSettings.findMany({
          where: eq(schema.orgBillingSettings.dunningState, "active"),
          columns: { orgId: true },
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
          logger.warn({ orgId, err }, "billing.dunning-sweep: low-balance check failed for org (non-fatal)");
        }
      }
      return count;
    });

    logger.info({ suspended: result.suspended, lowBalanceNotified: notified }, "billing.dunning-sweep complete");
    return { ...result, lowBalanceNotified: notified };
  },
);
