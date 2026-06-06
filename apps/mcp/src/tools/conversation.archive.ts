import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { conversationArchive } from "@oxagen/oxagen/contracts/conversation.archive";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...conversationArchive.input.shape,
  conversationIds: conversationArchive.input.shape.conversationIds.describe(
    "List of cnv_ public ids to archive or restore (1–100 items).",
  ),
  archived: conversationArchive.input.shape.archived.describe(
    "true to archive (sets archived_at); false to restore (clears archived_at).",
  ),
};

export const metadata: ToolMetadata = {
  name: conversationArchive.name,
  description: conversationArchive.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function conversationArchiveTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(conversationArchive.name, args, ctx, {
    surface: "mcp",
  });
  return conversationArchive.output.parse(output);
}
