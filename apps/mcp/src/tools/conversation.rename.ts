import { z } from "zod";
import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { conversationRename } from "@oxagen/oxagen/contracts/conversation.rename";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  conversationId: z
    .string()
    .min(1)
    .describe("The cnv_ public id of the conversation to rename."),
  title: z
    .string()
    .min(1)
    .max(200)
    .describe("New title for the conversation (1–200 characters)."),
};

export const metadata: ToolMetadata = {
  name: conversationRename.name,
  description: conversationRename.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function conversationRenameTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(conversationRename.name, args, ctx, {
    surface: "mcp",
  });
  return conversationRename.output.parse(output);
}
