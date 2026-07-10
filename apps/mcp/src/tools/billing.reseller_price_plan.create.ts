import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import {
  resellerPricePlanCreate,
  resellerPricePlanCreateFields,
} from "@oxagen/oxagen/contracts/billing.reseller_price_plan.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

// The contract input is refined (a ZodEffects with no `.shape`), so build the
// arg map from the exported raw fields.
export const schema = { ...resellerPricePlanCreateFields };

export const metadata: ToolMetadata = {
  name: resellerPricePlanCreate.name,
  description: resellerPricePlanCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function resellerPricePlanCreateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(resellerPricePlanCreate.name, args, ctx, {
    surface: "mcp",
  });
  return resellerPricePlanCreate.output.parse(output);
}
