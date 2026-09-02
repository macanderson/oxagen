import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { conversationChat } from "@oxagen/oxagen/contracts/conversation.chat";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...conversationChat.input.shape,
  conversation_id: conversationChat.input.shape.conversation_id.describe(
    "ID of the conversation to post to",
  ),
  message: conversationChat.input.shape.message.describe(
    "Message text to send",
  ),
};

export const metadata: ToolMetadata = {
  name: conversationChat.name,
  description: conversationChat.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function conversationChatTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(conversationChat.name, args, ctx, {
    surface: "mcp",
  });
  return conversationChat.output.parse(output);
}
