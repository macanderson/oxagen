import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import {
  billingActionUsage,
  billingActionUsageFields,
} from "@oxagen/oxagen/contracts/billing.action_usage";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = billingActionUsageFields;

export const metadata: ToolMetadata = {
  name: billingActionUsage.name,
  description: billingActionUsage.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function billingActionUsageTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(billingActionUsage.name, args, ctx, {
    surface: "mcp",
  });
  return billingActionUsage.output.parse(output);
}
