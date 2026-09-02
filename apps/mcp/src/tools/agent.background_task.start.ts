import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentTaskBackgroundStart } from "@oxagen/oxagen/contracts/agent.background_task.start";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentTaskBackgroundStart.input.shape,
  kind: agentTaskBackgroundStart.input.shape.kind.describe(
    "Task kind identifier (e.g. 'agent.run', 'data.export')",
  ),
  payload: agentTaskBackgroundStart.input.shape.payload.describe(
    "Arbitrary task payload - must be JSON-serialisable",
  ),
  label: agentTaskBackgroundStart.input.shape.label.describe(
    "Human-readable label for the task tray",
  ),
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
  const output = await invoke(agentTaskBackgroundStart.name, args, ctx, {
    surface: "mcp",
  });
  return agentTaskBackgroundStart.output.parse(output);
}
