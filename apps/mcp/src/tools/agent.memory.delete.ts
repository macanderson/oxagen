import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMemoryDelete } from "@oxagen/oxagen/contracts/agent.memory.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentMemoryDelete.input.shape,
  memoryId: agentMemoryDelete.input.shape.memoryId.describe(
    "The AgentMemory node id (not publicId) to permanently delete",
  ),
};

export const metadata: ToolMetadata = {
  name: agentMemoryDelete.name,
  description: agentMemoryDelete.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  },
};

export default async function agentMemoryDeleteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMemoryDelete.name, args, ctx, {
    surface: "mcp",
  });
  return agentMemoryDelete.output.parse(output);
}
