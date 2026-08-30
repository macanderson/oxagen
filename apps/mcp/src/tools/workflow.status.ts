import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { workflowStatus } from "@oxagen/oxagen/contracts/workflow.status";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  workflowId: workflowStatus.input.shape.workflowId.describe(
    "Public ID (wfr_*) or internal UUID of the workflow run",
  ),
};

export const metadata: ToolMetadata = {
  name: workflowStatus.name,
  description: workflowStatus.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function workflowStatusTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(workflowStatus.name, args, ctx, {
    surface: "mcp",
  });
  return workflowStatus.output.parse(output);
}
