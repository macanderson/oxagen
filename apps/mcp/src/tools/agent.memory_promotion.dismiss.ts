import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMemoryPromotionDismiss } from "@oxagen/oxagen/contracts/agent.memory_promotion.dismiss";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentMemoryPromotionDismiss.input.shape,
  memoryId: agentMemoryPromotionDismiss.input.shape.memoryId.describe(
    "The AgentMemory node id (not publicId) to dismiss",
  ),
  restore: agentMemoryPromotionDismiss.input.shape.restore.describe(
    "Clear a previous dismissal so the memory can appear as a candidate again",
  ),
};

export const metadata: ToolMetadata = {
  name: agentMemoryPromotionDismiss.name,
  description: agentMemoryPromotionDismiss.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentMemoryPromotionDismissTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMemoryPromotionDismiss.name, args, ctx, {
    surface: "mcp",
  });
  return agentMemoryPromotionDismiss.output.parse(output);
}
