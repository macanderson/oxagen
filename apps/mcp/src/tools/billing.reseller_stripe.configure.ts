import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { resellerStripeConfigure } from "@oxagen/oxagen/contracts/billing.reseller_stripe.configure";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...resellerStripeConfigure.input.shape };

export const metadata: ToolMetadata = {
  name: resellerStripeConfigure.name,
  description: resellerStripeConfigure.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function resellerStripeConfigureTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(resellerStripeConfigure.name, args, ctx, {
    surface: "mcp",
  });
  return resellerStripeConfigure.output.parse(output);
}
