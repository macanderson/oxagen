import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentSubagentFanoutGet } from "@oxagen/oxagen/contracts/agent.subagent_fanout.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentSubagentFanoutGet.input.shape,
  fanoutId: agentSubagentFanoutGet.input.shape.fanoutId.describe(
    "Public ID of the fan-out to fetch",
  ),
};

export const metadata: ToolMetadata = {
  name: agentSubagentFanoutGet.name,
  description: agentSubagentFanoutGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentSubagentFanoutGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentSubagentFanoutGet.name, args, ctx, {
    surface: "mcp",
  });
  return agentSubagentFanoutGet.output.parse(output);
}
