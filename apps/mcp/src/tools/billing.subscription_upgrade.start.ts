import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { billingSubscriptionUpgradeStart } from "@oxagen/oxagen/contracts/billing.subscription_upgrade.start";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...billingSubscriptionUpgradeStart.input.shape,
  planSlug: billingSubscriptionUpgradeStart.input.shape.planSlug.describe(
    "Target plan slug (e.g. 'pro', 'team')",
  ),
  interval:
    billingSubscriptionUpgradeStart.input.shape.interval.describe(
      "Billing interval",
    ),
  successUrl: billingSubscriptionUpgradeStart.input.shape.successUrl.describe(
    "URL to redirect to after successful checkout",
  ),
  cancelUrl: billingSubscriptionUpgradeStart.input.shape.cancelUrl.describe(
    "URL to redirect to on checkout cancellation",
  ),
};

export const metadata: ToolMetadata = {
  name: billingSubscriptionUpgradeStart.name,
  description: billingSubscriptionUpgradeStart.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function billingSubscriptionUpgradeStartTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(billingSubscriptionUpgradeStart.name, args, ctx, {
    surface: "mcp",
  });
  return billingSubscriptionUpgradeStart.output.parse(output);
}
