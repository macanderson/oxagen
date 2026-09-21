import { deliverUsageOutbox } from "@oxagen/billing";
import { createFunction } from "../create-function";
import { logger } from "../logger";

export const [billingUsageDelivery] = createFunction(
  { id: "billing.usage-delivery", retries: 3 },
  { cron: "* * * * *" },
  async ({ step }) => {
    const result = await step.run("deliver-usage", () => deliverUsageOutbox());
    logger.info(result, "Usage delivery batch complete");
    return result;
  },
);
