import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { resellerAttributionRuleSave } from "@oxagen/oxagen/contracts/billing.reseller_attribution_rule.save";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...resellerAttributionRuleSave.input.shape };

export const metadata: ToolMetadata = {
  name: resellerAttributionRuleSave.name,
  description: resellerAttributionRuleSave.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function resellerAttributionRuleSaveTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(resellerAttributionRuleSave.name, args, ctx, {
    surface: "mcp",
  });
  return resellerAttributionRuleSave.output.parse(output);
}
