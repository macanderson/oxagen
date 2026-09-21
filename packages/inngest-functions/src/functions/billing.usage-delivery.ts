import { deliverUsageOutbox } from "@oxagen/billing";
import { createFunction } from "../create-function";
import { logger } from "../logger";

export const [billingUsageDelivery] = createFunction(
  { id: "billing.usage-delivery", retries: 3, concurrency: { limit: 1 } },
  { cron: "* * * * *" },
  async ({ step }) => {
    // Freeze eligibility across durable steps. Failed rows back off beyond this
    // boundary and cannot trap the sweep in an immediate retry loop.
    const eligibleBefore = await step.run("delivery-boundary", () =>
      new Date().toISOString(),
    );
    const total = { delivered: 0, failed: 0, incomplete: 0 };
    for (let batch = 0; ; batch++) {
      const result = await step.run(`deliver-usage-${batch}`, () =>
        deliverUsageOutbox(100, new Date(eligibleBefore)),
      );
      total.delivered += result.delivered;
      total.failed += result.failed;
      total.incomplete = result.incomplete;
      if (result.selected < 100) break;
    }
    logger.info(total, "Usage delivery sweep complete");
    return total;
  },
);
