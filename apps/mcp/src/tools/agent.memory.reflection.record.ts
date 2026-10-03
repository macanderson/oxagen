import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMemoryReflectionRecord } from "@oxagen/oxagen/contracts/agent.memory.reflection.record";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = agentMemoryReflectionRecord.input.shape;

export const metadata: ToolMetadata = {
  name: agentMemoryReflectionRecord.name,
  description: agentMemoryReflectionRecord.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentMemoryReflectionRecordTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMemoryReflectionRecord.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(agentMemoryReflectionRecord.output.parse(output));
}
