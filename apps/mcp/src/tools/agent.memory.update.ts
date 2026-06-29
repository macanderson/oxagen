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
  weight: agentMemoryUpdate.input.shape.weight.describe("New salience bucket"),
  kind: agentMemoryUpdate.input.shape.kind.describe("New memory category"),
  source: agentMemoryUpdate.input.shape.source.describe("New provenance label"),
  confidence: agentMemoryUpdate.input.shape.confidence.describe(
    "New numeric salience/confidence (0–1)",
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
  const output = await invoke(agentMemoryUpdate.name, args, ctx, { surface: "mcp" });
  return agentMemoryUpdate.output.parse(output);
}
