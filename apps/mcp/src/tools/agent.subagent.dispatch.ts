import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentSubagentDispatch } from "@oxagen/oxagen/contracts/agent.subagent.dispatch";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentSubagentDispatch.input.shape,
  parentMessageId: agentSubagentDispatch.input.shape.parentMessageId.describe(
    "Message ID that triggered the fanout — used to group all child runs",
  ),
  tasks: agentSubagentDispatch.input.shape.tasks.describe(
    "Array of subtask definitions, each with a capabilityName and input payload",
  ),
  maxParallel: agentSubagentDispatch.input.shape.maxParallel.describe(
    "Max concurrent subagents (1–50, default 5)",
  ),
};

export const metadata: ToolMetadata = {
  name: agentSubagentDispatch.name,
  description: agentSubagentDispatch.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentSubagentDispatchTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentSubagentDispatch.name, args, ctx, {
    surface: "mcp",
  });
  return agentSubagentDispatch.output.parse(output);
}
