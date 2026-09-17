import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { approvalRuleSet } from "@oxagen/oxagen/contracts/approval_rule.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...approvalRuleSet.input.shape,
};

export const metadata: ToolMetadata = {
  name: approvalRuleSet.name,
  description: approvalRuleSet.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
};

export default async function approvalRuleSetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(approvalRuleSet.name, args, ctx, {
    surface: "mcp",
  });
  return approvalRuleSet.output.parse(output);
}
