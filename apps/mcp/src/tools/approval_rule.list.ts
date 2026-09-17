import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { approvalRuleList } from "@oxagen/oxagen/contracts/approval_rule.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...approvalRuleList.input.shape,
};

export const metadata: ToolMetadata = {
  name: approvalRuleList.name,
  description: approvalRuleList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function approvalRuleListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(approvalRuleList.name, args, ctx, {
    surface: "mcp",
  });
  return approvalRuleList.output.parse(output);
}
