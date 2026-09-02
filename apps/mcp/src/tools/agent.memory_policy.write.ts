import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMemoryPolicyWrite } from "@oxagen/oxagen/contracts/agent.memory_policy.write";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentMemoryPolicyWrite.input.shape,
  halfLifeLowDays: agentMemoryPolicyWrite.input.shape.halfLifeLowDays?.describe(
    "Decay half-life in days for OBSERVATION memories (default: 30)",
  ),
  halfLifeHighDays:
    agentMemoryPolicyWrite.input.shape.halfLifeHighDays?.describe(
      "Decay half-life in days for RULE memories (default: 90)",
    ),
  recallThreshold: agentMemoryPolicyWrite.input.shape.recallThreshold?.describe(
    "Minimum confidence [0..1] required for a memory to appear in recall results (default: 0.1)",
  ),
  complianceThreshold:
    agentMemoryPolicyWrite.input.shape.complianceThreshold?.describe(
      "Enforcement at or above which a rule deviation counts as a VIOLATION, else DISCRETION (default: 70)",
    ),
  defaultDecayFloor:
    agentMemoryPolicyWrite.input.shape.defaultDecayFloor?.describe(
      "Confidence never auto-decays below this floor (default: 5)",
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
  const output = await invoke(agentMemoryPolicyWrite.name, args, ctx, {
    surface: "mcp",
  });
  return agentMemoryPolicyWrite.output.parse(output);
}
