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
  weight: agentMemoryWrite.input.shape.weight.describe("Memory weight / priority"),
  kind: agentMemoryWrite.input.shape.kind.describe("Memory category"),
  lesson: agentMemoryWrite.input.shape.lesson.describe("The lesson or insight to persist"),
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
  const output = await invoke(agentMemoryWrite.name, args, ctx, { surface: "mcp" });
  return agentMemoryWrite.output.parse(output);
}
