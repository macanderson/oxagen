import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { conversationExport } from "@oxagen/oxagen/contracts/conversation.export";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  conversationId: conversationExport.input.shape.conversationId.describe(
    "The public ID of the conversation to export.",
  ),
  format: conversationExport.input.shape.format.describe(
    '"markdown" returns the serialized document inline; "pdf" renders a formatted PDF, stores it privately, and returns its serve URL.',
  ),
};

export const metadata: ToolMetadata = {
  name: conversationExport.name,
  description: conversationExport.description,
  annotations: {
    // PDF export persists a (private, unlinked) generated asset, so the tool
    // is not strictly read-only or idempotent.
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function conversationExportTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(conversationExport.name, args, ctx, {
    surface: "mcp",
  });
  return conversationExport.output.parse(output);
}
