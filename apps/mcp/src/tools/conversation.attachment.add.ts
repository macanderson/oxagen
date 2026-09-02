import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { conversationAttachmentAdd } from "@oxagen/oxagen/contracts/conversation.attachment.add";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  conversationId: conversationAttachmentAdd.input.shape.conversationId.describe(
    "The public ID of the conversation to attach the asset to.",
  ),
  assetPublicId: conversationAttachmentAdd.input.shape.assetPublicId.describe(
    'The public ID (gen_…) of an already-uploaded/generated asset — e.g. the publicId returned by upload_asset with source="user_upload". Must be ready and belong to the caller.',
  ),
};

export const metadata: ToolMetadata = {
  name: conversationAttachmentAdd.name,
  description: conversationAttachmentAdd.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function conversationAttachmentAddTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(conversationAttachmentAdd.name, args, ctx, {
    surface: "mcp",
  });
  return conversationAttachmentAdd.output.parse(output);
}
