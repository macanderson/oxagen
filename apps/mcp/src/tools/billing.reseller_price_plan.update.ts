import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { resellerPricePlanUpdate } from "@oxagen/oxagen/contracts/billing.reseller_price_plan.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...resellerPricePlanUpdate.input.shape };

export const metadata: ToolMetadata = {
  name: resellerPricePlanUpdate.name,
  description: resellerPricePlanUpdate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function resellerPricePlanUpdateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(resellerPricePlanUpdate.name, args, ctx, {
    surface: "mcp",
  });
  return resellerPricePlanUpdate.output.parse(output);
}
