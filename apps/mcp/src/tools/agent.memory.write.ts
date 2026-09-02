import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMemoryWrite } from "@oxagen/oxagen/contracts/agent.memory.write";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentMemoryWrite.input.shape,
  nodeRef: agentMemoryWrite.input.shape.nodeRef.describe(
    "Graph node reference to attach the memory to",
  ),
  memoryClass: agentMemoryWrite.input.shape.memoryClass.describe(
    "Epistemic class; new memories default to OBSERVATION",
  ),
  memoryKind: agentMemoryWrite.input.shape.memoryKind.describe(
    "Content domain of the memory",
  ),
  enforcementScore: agentMemoryWrite.input.shape.enforcementScore.describe(
    "Required when memoryClass is RULE (1-100); ignored for OBSERVATION",
  ),
  lesson: agentMemoryWrite.input.shape.lesson.describe(
    "The lesson or insight to persist",
  ),
  source: agentMemoryWrite.input.shape.source.describe("Origin of the memory"),
};

export const metadata: ToolMetadata = {
  name: agentMemoryWrite.name,
  description: agentMemoryWrite.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function agentMemoryWriteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMemoryWrite.name, args, ctx, {
    surface: "mcp",
  });
  return agentMemoryWrite.output.parse(output);
}
