import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentTaskBackgroundCancel } from "@oxagen/oxagen/contracts/agent.task.background.cancel";
import { agentTaskBackgroundCancelHandler } from "@oxagen/agent/handlers/agent.task.background.cancel";
import { buildContext } from "../context.js";

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
  const ctx = buildContext(headers());
  const output = await agentTaskBackgroundCancelHandler(args, ctx);
  return agentTaskBackgroundCancel.output.parse(output);
}
