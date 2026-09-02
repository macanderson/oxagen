import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentSubagentLogs } from "@oxagen/oxagen/contracts/agent.subagent.logs";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentSubagentLogs.input.shape,
  fanoutId: agentSubagentLogs.input.shape.fanoutId.describe(
    "The fan-out / dispatch id (the dispatchId from start_research_swarm or dispatch_subagent).",
  ),
  title: agentSubagentLogs.input.shape.title.describe(
    "Optional title for the log document.",
  ),
};

export const metadata: ToolMetadata = {
  name: agentSubagentLogs.name,
  description: agentSubagentLogs.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentSubagentLogsTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentSubagentLogs.name, args, ctx, {
    surface: "mcp",
  });
  return agentSubagentLogs.output.parse(output);
}
