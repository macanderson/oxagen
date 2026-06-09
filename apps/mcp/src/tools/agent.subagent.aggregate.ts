import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentSubagentAggregate } from "@oxagen/oxagen/contracts/agent.subagent.aggregate";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  fanoutId: agentSubagentAggregate.input.shape.fanoutId.describe(
    "Public ID of the subagent fanout to aggregate",
  ),
  timeoutMs: agentSubagentAggregate.input.shape.timeoutMs.describe(
    "Max milliseconds to wait for all children (default 5 min, max 30 min)",
  ),
};

export const metadata: ToolMetadata = {
  name: agentSubagentAggregate.name,
  description: agentSubagentAggregate.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentSubagentAggregateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentSubagentAggregate.name, args, ctx, { surface: "mcp" });
  return agentSubagentAggregate.output.parse(output);
}
