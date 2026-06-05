import { inngest } from "../inngest";
import { sweepDunning } from "@oxagen/billing";
import { logger } from "../logger";

/**
 * Daily sweep: move any orgs still in 'grace' whose graceEndsAt has elapsed
 * to 'suspended'. Runs at 02:00 UTC daily.
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

    logger.info({ suspended: result.suspended }, "billing.dunning-sweep complete");
    return result;
  },
);
