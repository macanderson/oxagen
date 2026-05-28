import { chatMessageSend } from "@oxagen/oxagen/capabilities/chat.message.send";
import { chatMessageSendHandler } from "@oxagen/oxagen/capabilities/chat.message.send.handler";
import { placeholderContext } from "../context.js";
import type { McpTool } from "../server.js";

export const chatMessageSendTool: McpTool = {
  name: chatMessageSend.name,
  description: chatMessageSend.description,
  invoke: async (raw) => {
    const input = chatMessageSend.input.parse(raw);
    const output = await chatMessageSendHandler(input, placeholderContext());
    return chatMessageSend.output.parse(output);
  },
};
