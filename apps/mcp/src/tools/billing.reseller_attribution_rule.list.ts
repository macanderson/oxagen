import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { resellerAttributionRuleList } from "@oxagen/oxagen/contracts/billing.reseller_attribution_rule.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...resellerAttributionRuleList.input.shape };

export const metadata: ToolMetadata = {
  name: resellerAttributionRuleList.name,
  description: resellerAttributionRuleList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function resellerAttributionRuleListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(resellerAttributionRuleList.name, args, ctx, {
    surface: "mcp",
  });
  return resellerAttributionRuleList.output.parse(output);
}
