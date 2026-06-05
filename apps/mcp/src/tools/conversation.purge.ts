import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { conversationPurge } from "@oxagen/oxagen/contracts/conversation.purge";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {};

export const metadata: ToolMetadata = {
  name: conversationPurge.name,
  description: conversationPurge.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
  },
};

export default async function conversationPurgeTool(
  _args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(conversationPurge.name, {}, ctx, {
    surface: "mcp",
  });
  return conversationPurge.output.parse(output);
}
