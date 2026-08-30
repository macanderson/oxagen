import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMemoryRecall } from "@oxagen/oxagen/contracts/agent.memory.recall";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentMemoryRecall.input.shape,
  query: agentMemoryRecall.input.shape.query.describe("Semantic search query"),
  memoryClass: agentMemoryRecall.input.shape.memoryClass.describe(
    "Only recall memories of this epistemic class",
  ),
  minEnforcement: agentMemoryRecall.input.shape.minEnforcement.describe(
    "Only recall rules at or above this enforcement score",
  ),
  limit: agentMemoryRecall.input.shape.limit.describe(
    "Maximum number of memories to return",
  ),
  nodeRef: agentMemoryRecall.input.shape.nodeRef.describe(
    "Optional graph node to scope the search",
  ),
};

export const metadata: ToolMetadata = {
  name: agentMemoryRecall.name,
  description: agentMemoryRecall.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentMemoryRecallTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMemoryRecall.name, args, ctx, {
    surface: "mcp",
  });
  return agentMemoryRecall.output.parse(output);
}
