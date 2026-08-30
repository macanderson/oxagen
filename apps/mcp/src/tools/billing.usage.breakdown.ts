import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import {
  billingUsageBreakdown,
  billingUsageBreakdownFields,
} from "@oxagen/oxagen/contracts/billing.usage.breakdown";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = billingUsageBreakdownFields;

export const metadata: ToolMetadata = {
  name: billingUsageBreakdown.name,
  description: billingUsageBreakdown.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function billingUsageBreakdownTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(billingUsageBreakdown.name, args, ctx, {
    surface: "mcp",
  });
  return billingUsageBreakdown.output.parse(output);
}
