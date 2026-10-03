import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentMemoryLessonRemember } from "@oxagen/oxagen/contracts/agent.memory.lesson.remember";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = agentMemoryLessonRemember.input.shape;

export const metadata: ToolMetadata = {
  name: agentMemoryLessonRemember.name,
  description: agentMemoryLessonRemember.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentMemoryLessonRememberTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentMemoryLessonRemember.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(agentMemoryLessonRemember.output.parse(output));
}
