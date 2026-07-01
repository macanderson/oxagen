import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMemoryPromotionCandidates } from "@oxagen/oxagen/contracts/agent.memory.promotion.candidates";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentMemoryPromotionCandidates.input.shape,
  limit: agentMemoryPromotionCandidates.input.shape.limit.describe(
    "Maximum number of promotion candidates to return",
  ),
};

export const metadata: ToolMetadata = {
  name: agentMemoryPromotionCandidates.name,
  description: agentMemoryPromotionCandidates.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentMemoryPromotionCandidatesTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMemoryPromotionCandidates.name, args, ctx, {
    surface: "mcp",
  });
  return agentMemoryPromotionCandidates.output.parse(output);
}
