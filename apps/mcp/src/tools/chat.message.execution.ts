import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { chatMessageExecution } from "@oxagen/oxagen/contracts/chat.message.execution";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...chatMessageExecution.input.shape,
};

export const metadata: ToolMetadata = {
  name: chatMessageExecution.name,
  description: chatMessageExecution.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function chatMessageExecutionTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(chatMessageExecution.name, args, ctx, {
    surface: "mcp",
  });
  return chatMessageExecution.output.parse(output);
}
