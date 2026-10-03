import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import {
  billingActionEstimate,
  billingActionEstimateFields,
} from "@oxagen/oxagen/contracts/billing.action_estimate";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = billingActionEstimateFields;

export const metadata: ToolMetadata = {
  name: billingActionEstimate.name,
  description: billingActionEstimate.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function billingActionEstimateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(billingActionEstimate.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(billingActionEstimate.output.parse(output));
}
