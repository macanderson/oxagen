import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { billingCreditsPurchase } from "@oxagen/oxagen/contracts/billing.credits.purchase";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...billingCreditsPurchase.input.shape,
  amountUsd: billingCreditsPurchase.input.shape.amountUsd.describe(
    "Dollar amount of usage credits to purchase (face value), e.g. 50 for $50. Minimum $5. A volume discount is applied: you pay less but receive the full face-value in credits.",
  ),
};

export const metadata: ToolMetadata = {
  name: billingCreditsPurchase.name,
  description: billingCreditsPurchase.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function billingCreditsPurchaseTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(billingCreditsPurchase.name, args, ctx, {
    surface: "mcp",
  });
  return billingCreditsPurchase.output.parse(output);
}
