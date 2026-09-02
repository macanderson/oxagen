import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentTaskBackgroundRead } from "@oxagen/oxagen/contracts/agent.background_task.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentTaskBackgroundRead.input.shape,
  taskId: agentTaskBackgroundRead.input.shape.taskId.describe(
    "ID of the background task",
  ),
};

export const metadata: ToolMetadata = {
  name: agentTaskBackgroundRead.name,
  description: agentTaskBackgroundRead.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentTaskBackgroundReadTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentTaskBackgroundRead.name, args, ctx, {
    surface: "mcp",
  });
  return agentTaskBackgroundRead.output.parse(output);
}
