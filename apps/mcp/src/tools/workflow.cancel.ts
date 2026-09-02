import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { workflowCancel } from "@oxagen/oxagen/contracts/workflow.cancel";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  workflowId: workflowCancel.input.shape.workflowId.describe(
    "Public ID (wfr_*) or internal UUID of the workflow run to cancel",
  ),
};

export const metadata: ToolMetadata = {
  name: workflowCancel.name,
  description: workflowCancel.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function workflowCancelTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(workflowCancel.name, args, ctx, {
    surface: "mcp",
  });
  return workflowCancel.output.parse(output);
}
