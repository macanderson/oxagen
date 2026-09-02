import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMemoryUpdate } from "@oxagen/oxagen/contracts/agent.memory.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentMemoryUpdate.input.shape,
  memoryId: agentMemoryUpdate.input.shape.memoryId.describe(
    "The AgentMemory node id (not publicId) to update",
  ),
  lesson: agentMemoryUpdate.input.shape.lesson.describe(
    "Replacement lesson text; triggers a re-embed",
  ),
  memoryKind: agentMemoryUpdate.input.shape.memoryKind.describe(
    "New content-domain kind",
  ),
  source: agentMemoryUpdate.input.shape.source.describe("New provenance label"),
  confidenceScore: agentMemoryUpdate.input.shape.confidenceScore.describe(
    "New confidence (0-100); the decay pass evolves it over time",
  ),
  enforcementScore: agentMemoryUpdate.input.shape.enforcementScore.describe(
    "New enforcement (1-100) for a RULE; policy, does not decay",
  ),
  status: agentMemoryUpdate.input.shape.status.describe(
    "New lifecycle status (e.g. ARCHIVED, RETRACTED)",
  ),
};

export const metadata: ToolMetadata = {
  name: agentMemoryUpdate.name,
  description: agentMemoryUpdate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentMemoryUpdateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMemoryUpdate.name, args, ctx, {
    surface: "mcp",
  });
  return agentMemoryUpdate.output.parse(output);
}
