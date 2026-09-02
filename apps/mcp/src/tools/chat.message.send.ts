import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { chatMessageSend } from "@oxagen/oxagen/contracts/chat.message.send";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...chatMessageSend.input.shape,
  conversationId: chatMessageSend.input.shape.conversationId.describe(
    "Existing conversation ID, or null to start a new conversation",
  ),
  parentMessageId: chatMessageSend.input.shape.parentMessageId.describe(
    "Parent message ID for branching, or null",
  ),
  branchReason: chatMessageSend.input.shape.branchReason.describe(
    "Reason for branching off an existing message, or null",
  ),
  content: chatMessageSend.input.shape.content.describe("User message text"),
  contentBlocks: chatMessageSend.input.shape.contentBlocks.describe(
    "Optional structured content blocks (attachments, images, etc.)",
  ),
};

export const metadata: ToolMetadata = {
  name: chatMessageSend.name,
  description: chatMessageSend.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function chatMessageSendTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(chatMessageSend.name, args, ctx, {
    surface: "mcp",
  });
  return chatMessageSend.output.parse(output);
}
