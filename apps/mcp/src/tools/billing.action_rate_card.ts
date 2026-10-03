import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { billingActionRateCard } from "@oxagen/oxagen/contracts/billing.action_rate_card";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {};

export const metadata: ToolMetadata = {
  name: billingActionRateCard.name,
  description: billingActionRateCard.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function billingActionRateCardTool(
  _args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(billingActionRateCard.name, {}, ctx, {
    surface: "mcp",
  });
  return toolResult(billingActionRateCard.output.parse(output));
}
