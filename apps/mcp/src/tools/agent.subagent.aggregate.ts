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
    "Snapshot staleness window in ms (default 5 min, max 30 min) — non-blocking, never sleeps",
  ),
  includeOutputs: agentSubagentAggregate.input.shape.includeOutputs.describe(
    "DEPRECATED: relay full child payloads (capped). Prefer the default compact summaries + get_subagent_result for the one child you need",
  ),
  includeMerged: agentSubagentAggregate.input.shape.includeMerged.describe(
    "Include deep-merged aggregatedData (capped; conflicts are always returned)",
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
  const output = await invoke(agentSubagentAggregate.name, args, ctx, {
    surface: "mcp",
  });
  return agentSubagentAggregate.output.parse(output);
}
