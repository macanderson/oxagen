import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { approvalAutoEligibilityGet } from "@oxagen/oxagen/contracts/approval.auto_eligibility.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  ...approvalAutoEligibilityGet.input.shape,
};

export const metadata: ToolMetadata = {
  name: approvalAutoEligibilityGet.name,
  description: approvalAutoEligibilityGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function approvalAutoEligibilityGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(approvalAutoEligibilityGet.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(approvalAutoEligibilityGet.output.parse(output));
}
