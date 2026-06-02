import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentTaskBackgroundStart } from "@oxagen/oxagen/contracts/agent.task.background.start";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

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
  const ctx = await buildContext(headers());
  const output = await invoke(agentTaskBackgroundStart.name, args, ctx, { surface: "mcp" });
  return agentTaskBackgroundStart.output.parse(output);
}
