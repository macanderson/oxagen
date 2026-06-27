import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMemoryPolicyWrite } from "@oxagen/oxagen/contracts/agent.memory.policy.write";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentMemoryPolicyWrite.input.shape,
  halfLifeLowDays: agentMemoryPolicyWrite.input.shape.halfLifeLowDays?.describe(
    "Decay half-life in days for 'low' weight memories (default: 30)",
  ),
  halfLifeHighDays: agentMemoryPolicyWrite.input.shape.halfLifeHighDays?.describe(
    "Decay half-life in days for 'high' weight memories (default: 90)",
  ),
  recallThreshold: agentMemoryPolicyWrite.input.shape.recallThreshold?.describe(
    "Minimum confidence [0..1] required for a memory to appear in recall results (default: 0.1)",
  ),
};

export const metadata: ToolMetadata = {
  name: agentMemoryPolicyWrite.name,
  description: agentMemoryPolicyWrite.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentMemoryPolicyWriteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMemoryPolicyWrite.name, args, ctx, { surface: "mcp" });
  return agentMemoryPolicyWrite.output.parse(output);
}
