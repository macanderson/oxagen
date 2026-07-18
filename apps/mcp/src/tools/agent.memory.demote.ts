import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMemoryDemote } from "@oxagen/oxagen/contracts/agent.memory.demote";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentMemoryDemote.input.shape,
  memoryId: agentMemoryDemote.input.shape.memoryId.describe(
    "The AgentMemory node id (not publicId) to demote",
  ),
  toClass: agentMemoryDemote.input.shape.toClass.describe(
    "Target class; must be strictly below the memory's current class (FACT cannot be a demotion target)",
  ),
  enforcementScore: agentMemoryDemote.input.shape.enforcementScore.describe(
    "Enforcement (1-100) to set when demoting to RULE; ignored for OBSERVATION (forced null)",
  ),
  rationale: agentMemoryDemote.input.shape.rationale.describe(
    "Optional: why this memory is being demoted",
  ),
};

export const metadata: ToolMetadata = {
  name: agentMemoryDemote.name,
  description: agentMemoryDemote.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentMemoryDemoteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMemoryDemote.name, args, ctx, {
    surface: "mcp",
  });
  return agentMemoryDemote.output.parse(output);
}
