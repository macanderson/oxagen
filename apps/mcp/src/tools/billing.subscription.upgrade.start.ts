import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { billingSubscriptionUpgradeStart } from "@oxagen/oxagen/contracts/billing.subscription.upgrade.start";
import { billingSubscriptionUpgradeStartHandler } from "@oxagen/handlers/billing.subscription.upgrade.start";
import { buildContext } from "../context.js";

export const schema = {
  planSlug: z.string().min(1).describe("Target plan slug (e.g. 'pro', 'team')"),
  interval: z.enum(["month", "year"]).describe("Billing interval"),
  successUrl: z.string().url().describe("URL to redirect to after successful checkout"),
  cancelUrl: z.string().url().describe("URL to redirect to on checkout cancellation"),
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
  const ctx = buildContext(headers());
  const output = await billingSubscriptionUpgradeStartHandler(args, ctx);
  return billingSubscriptionUpgradeStart.output.parse(output);
}
