import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMemoryRecall } from "@oxagen/oxagen/contracts/agent.memory.recall";
import { agentMemoryRecallHandler } from "@oxagen/agent/handlers/agent.memory.recall";
import { buildContext } from "../context.js";

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
  const output = await agentMemoryRecallHandler(args, ctx);
  return agentMemoryRecall.output.parse(output);
}
