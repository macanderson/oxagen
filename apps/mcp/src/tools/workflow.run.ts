import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { workflowRun } from "@oxagen/oxagen/contracts/workflow.run";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...workflowRun.input.shape,
  goal: workflowRun.input.shape.goal.describe(
    "The overarching research or processing goal (e.g. 'Profile all Fortune 500 CEOs')",
  ),
};

export const metadata: ToolMetadata = {
  name: workflowRun.name,
  description: workflowRun.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function workflowRunTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(workflowRun.name, args, ctx, { surface: "mcp" });
  return workflowRun.output.parse(output);
}
