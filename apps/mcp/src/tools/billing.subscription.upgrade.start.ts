import { billingSubscriptionUpgradeStart } from "@oxagen/oxagen/contracts/billing.subscription.upgrade.start";
import { billingSubscriptionUpgradeStartHandler } from "@oxagen/handlers/billing.subscription.upgrade.start";
import { placeholderContext } from "../context.js";
import type { McpTool } from "../server.js";

export const billingSubscriptionUpgradeStartTool: McpTool = {
  name: billingSubscriptionUpgradeStart.name,
  description: billingSubscriptionUpgradeStart.description,
  invoke: async (raw) => {
    const input = billingSubscriptionUpgradeStart.input.parse(raw);
    const output = await billingSubscriptionUpgradeStartHandler(input, placeholderContext());
    return billingSubscriptionUpgradeStart.output.parse(output);
  },
};
