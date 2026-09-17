import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { approvalRuleDelete } from "@oxagen/oxagen/contracts/approval_rule.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...approvalRuleDelete.input.shape,
};

export const metadata: ToolMetadata = {
  name: approvalRuleDelete.name,
  description: approvalRuleDelete.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
};

export default async function approvalRuleDeleteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(approvalRuleDelete.name, args, ctx, {
    surface: "mcp",
  });
  return approvalRuleDelete.output.parse(output);
}
