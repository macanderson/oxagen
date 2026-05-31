import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentTaskBackgroundStart } from "@oxagen/oxagen/contracts/agent.task.background.start";
import { agentTaskBackgroundStartHandler } from "@oxagen/agent/handlers/agent.task.background.start";
import { buildContext } from "../context.js";

export const schema = {
  kind: z.string().describe("Task kind identifier (e.g. 'agent.run', 'data.export')"),
  payload: z.unknown().describe("Arbitrary task payload - must be JSON-serialisable"),
  label: z.string().optional().describe("Human-readable label for the task tray"),
};

export const metadata: ToolMetadata = {
  name: agentTaskBackgroundStart.name,
  description: agentTaskBackgroundStart.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentTaskBackgroundStartTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = buildContext(headers());
  const output = await agentTaskBackgroundStartHandler(args, ctx);
  return agentTaskBackgroundStart.output.parse(output);
}
