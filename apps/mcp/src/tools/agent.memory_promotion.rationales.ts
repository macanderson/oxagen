import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMemoryPromotionRationales } from "@oxagen/oxagen/contracts/agent.memory_promotion.rationales";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentMemoryPromotionRationales.input.shape,
  memoryId: agentMemoryPromotionRationales.input.shape.memoryId.describe(
    "The AgentMemory node id (not publicId) being promoted or demoted",
  ),
  toClass: agentMemoryPromotionRationales.input.shape.toClass.describe(
    "The class change being considered (promotion or demotion target)",
  ),
  count: agentMemoryPromotionRationales.input.shape.count.describe(
    "How many candidate rationales to draft",
  ),
};

export const metadata: ToolMetadata = {
  name: agentMemoryPromotionRationales.name,
  description: agentMemoryPromotionRationales.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentMemoryPromotionRationalesTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMemoryPromotionRationales.name, args, ctx, {
    surface: "mcp",
  });
  return agentMemoryPromotionRationales.output.parse(output);
}
