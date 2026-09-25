import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { conversationGet } from "@oxagen/oxagen/contracts/conversation.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  conversationId: conversationGet.input.shape.conversationId.describe(
    "The cnv_ public id of the conversation to read. Null reads your most recently updated active conversation in this workspace.",
  ),
  limit: conversationGet.input.shape.limit.describe(
    "The newest messages to return, 1 to 200. Defaults to 100.",
  ),
};

export const metadata: ToolMetadata = {
  name: conversationGet.name,
  description: conversationGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function conversationGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(conversationGet.name, args, ctx, {
    surface: "mcp",
  });
  return conversationGet.output.parse(output);
}
