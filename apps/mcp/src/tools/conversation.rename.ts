import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { conversationRename } from "@oxagen/oxagen/contracts/conversation.rename";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...conversationRename.input.shape,
  conversationId: conversationRename.input.shape.conversationId.describe(
    "The cnv_ public id of the conversation to rename.",
  ),
  title: conversationRename.input.shape.title.describe(
    "New title for the conversation (1–200 characters).",
  ),
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
