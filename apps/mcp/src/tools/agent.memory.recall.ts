import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMemoryRecall } from "@oxagen/oxagen/contracts/agent.memory.recall";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  query: z.string().min(1).describe("Semantic search query"),
  minWeight: z
    .enum(["low", "high", "critical"])
    .default("high")
    .describe("Minimum memory weight threshold"),
  limit: z
    .number()
    .int()
    .positive()
    .max(50)
    .default(10)
    .describe("Maximum number of memories to return"),
  nodeRef: z.string().optional().describe("Optional graph node to scope the search"),
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
  const output = await invoke(agentMemoryRecall.name, args, ctx, { surface: "mcp" });
  return agentMemoryRecall.output.parse(output);
}
