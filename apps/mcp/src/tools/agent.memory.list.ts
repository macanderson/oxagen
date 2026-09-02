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
  memoryClass: agentMemoryList.input.shape.memoryClass.describe(
    "Filter to a single epistemic class (OBSERVATION/RULE/FACT)",
  ),
  memoryKind: agentMemoryList.input.shape.memoryKind.describe(
    "Filter to a single memory kind (content domain)",
  ),
  minEnforcement: agentMemoryList.input.shape.minEnforcement.describe(
    "Only return rules at or above this enforcement score",
  ),
  minCitations: agentMemoryList.input.shape.minCitations.describe(
    "Only return memories cited at least this many times",
  ),
  sort: agentMemoryList.input.shape.sort.describe(
    "Ordering axis: createdAt (recency) or citationCount (how often the memory has been cited)",
  ),
  sortDir: agentMemoryList.input.shape.sortDir.describe(
    "Sort direction; defaults to descending (newest / most-cited first)",
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
  const output = await invoke(agentMemoryList.name, args, ctx, {
    surface: "mcp",
  });
  return agentMemoryList.output.parse(output);
}
