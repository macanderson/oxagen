import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { approvalRuleEnabledSet } from "@oxagen/oxagen/contracts/approval_rule.enabled.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...approvalRuleEnabledSet.input.shape,
};

export const metadata: ToolMetadata = {
  name: approvalRuleEnabledSet.name,
  description: approvalRuleEnabledSet.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function approvalRuleEnabledSetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(approvalRuleEnabledSet.name, args, ctx, {
    surface: "mcp",
  });
  return approvalRuleEnabledSet.output.parse(output);
}
