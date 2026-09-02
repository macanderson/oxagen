import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentTaskBackgroundCancel } from "@oxagen/oxagen/contracts/agent.background_task.cancel";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentTaskBackgroundCancel.input.shape,
  taskId: agentTaskBackgroundCancel.input.shape.taskId.describe(
    "ID of the background task to cancel",
  ),
  reason: agentTaskBackgroundCancel.input.shape.reason.describe(
    "Optional reason for cancellation",
  ),
};

export const metadata: ToolMetadata = {
  name: agentTaskBackgroundCancel.name,
  description: agentTaskBackgroundCancel.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function agentTaskBackgroundCancelTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentTaskBackgroundCancel.name, args, ctx, {
    surface: "mcp",
  });
  return agentTaskBackgroundCancel.output.parse(output);
}
