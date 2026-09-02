import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMemoryPromote } from "@oxagen/oxagen/contracts/agent.memory.promote";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentMemoryPromote.input.shape,
  memoryId: agentMemoryPromote.input.shape.memoryId.describe(
    "The AgentMemory node id (not publicId) to promote",
  ),
  toClass: agentMemoryPromote.input.shape.toClass.describe(
    "Target class; OBSERVATION cannot be a promotion target",
  ),
  enforcementScore: agentMemoryPromote.input.shape.enforcementScore.describe(
    "Enforcement (1-100) to set for a RULE; ignored for FACT (forced 100)",
  ),
  rationale: agentMemoryPromote.input.shape.rationale.describe(
    "Why this memory is being promoted",
  ),
  basedOnEvidenceIds:
    agentMemoryPromote.input.shape.basedOnEvidenceIds.describe(
      "Evidence node ids supporting the promotion — creates :BASED_ON edges",
    ),
};

export const metadata: ToolMetadata = {
  name: agentMemoryPromote.name,
  description: agentMemoryPromote.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentMemoryPromoteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMemoryPromote.name, args, ctx, {
    surface: "mcp",
  });
  return agentMemoryPromote.output.parse(output);
}
