import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMemoryList } from "@oxagen/oxagen/contracts/agent.memory.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentMemoryList.input.shape,
  nodeRef: agentMemoryList.input.shape.nodeRef.describe(
    "Scope to memories anchored on a single graph node ref",
  ),
  minWeight: agentMemoryList.input.shape.minWeight.describe(
    "Only return memories at or above this weight",
  ),
  kind: agentMemoryList.input.shape.kind.describe(
    "Filter to a single memory kind",
  ),
  limit: agentMemoryList.input.shape.limit.describe(
    "Maximum number of memories to return",
  ),
  offset: agentMemoryList.input.shape.offset.describe(
    "Number of memories to skip for pagination",
  ),
};

export const metadata: ToolMetadata = {
  name: agentMemoryList.name,
  description: agentMemoryList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentMemoryListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMemoryList.name, args, ctx, { surface: "mcp" });
  return agentMemoryList.output.parse(output);
}
