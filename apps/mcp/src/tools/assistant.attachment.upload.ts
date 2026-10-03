import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { assistantAttachmentUpload } from "@oxagen/oxagen/contracts/assistant.attachment.upload";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = { ...assistantAttachmentUpload.input.shape };

export const metadata: ToolMetadata = {
  name: assistantAttachmentUpload.name,
  description: assistantAttachmentUpload.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function uploadAssistantAttachmentTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(assistantAttachmentUpload.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(assistantAttachmentUpload.output.parse(output));
}
