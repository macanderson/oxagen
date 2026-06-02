import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentTaskBackgroundCancel } from "@oxagen/oxagen/contracts/agent.task.background.cancel";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  taskId: z.string().describe("ID of the background task to cancel"),
  reason: z.string().optional().describe("Optional reason for cancellation"),
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
  const output = await invoke(agentTaskBackgroundCancel.name, args, ctx, { surface: "mcp" });
  return agentTaskBackgroundCancel.output.parse(output);
}
