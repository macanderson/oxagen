import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { resellerStripeStatus } from "@oxagen/oxagen/contracts/billing.reseller_stripe.status";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...resellerStripeStatus.input.shape };

export const metadata: ToolMetadata = {
  name: resellerStripeStatus.name,
  description: resellerStripeStatus.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function resellerStripeStatusTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(resellerStripeStatus.name, args, ctx, {
    surface: "mcp",
  });
  return resellerStripeStatus.output.parse(output);
}
