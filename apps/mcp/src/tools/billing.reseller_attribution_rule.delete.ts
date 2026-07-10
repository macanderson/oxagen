import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { resellerAttributionRuleDelete } from "@oxagen/oxagen/contracts/billing.reseller_attribution_rule.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...resellerAttributionRuleDelete.input.shape };

export const metadata: ToolMetadata = {
  name: resellerAttributionRuleDelete.name,
  description: resellerAttributionRuleDelete.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
};

export default async function resellerAttributionRuleDeleteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(resellerAttributionRuleDelete.name, args, ctx, {
    surface: "mcp",
  });
  return resellerAttributionRuleDelete.output.parse(output);
}
