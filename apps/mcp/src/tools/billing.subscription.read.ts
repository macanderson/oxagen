import { billingSubscriptionRead } from "@oxagen/oxagen/capabilities/billing.subscription.read";
import { billingSubscriptionReadHandler } from "@oxagen/handlers/billing.subscription.read";
import { placeholderContext } from "../context.js";
import type { McpTool } from "../server.js";

export const billingSubscriptionReadTool: McpTool = {
  name: billingSubscriptionRead.name,
  description: billingSubscriptionRead.description,
  invoke: async (raw) => {
    const input = billingSubscriptionRead.input.parse(raw);
    const output = await billingSubscriptionReadHandler(
      input,
      placeholderContext(),
    );
    return billingSubscriptionRead.output.parse(output);
  },
};
