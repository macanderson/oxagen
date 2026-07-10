import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { resellerPricePlanList } from "@oxagen/oxagen/contracts/billing.reseller_price_plan.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...resellerPricePlanList.input.shape };

export const metadata: ToolMetadata = {
  name: resellerPricePlanList.name,
  description: resellerPricePlanList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function resellerPricePlanListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(resellerPricePlanList.name, args, ctx, {
    surface: "mcp",
  });
  return resellerPricePlanList.output.parse(output);
}
