import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { chatMessageSend } from "@oxagen/oxagen/contracts/chat.message.send";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context.js";

export const schema = {
  conversationId: z
    .string()
    .nullable()
    .describe("Existing conversation ID, or null to start a new conversation"),
  agentVersionId: z
    .string()
    .nullable()
    .describe("Agent version to use, or null for the workspace default"),
  parentMessageId: z
    .string()
    .nullable()
    .describe("Parent message ID for branching, or null"),
  branchReason: z
    .enum(["edit", "regenerate", "tool_retry", "manual_fork"])
    .nullable()
    .describe("Reason for branching off an existing message, or null"),
  content: z.string().min(1).describe("User message text"),
  contentBlocks: z
    .array(z.unknown())
    .default([])
    .describe("Optional structured content blocks (attachments, images, etc.)"),
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
  const output = await invoke(chatMessageSend.name, args, ctx, { surface: "mcp" });
  return chatMessageSend.output.parse(output);
}
