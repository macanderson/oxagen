import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { connectionPreview } from "@oxagen/oxagen/contracts/connection.preview";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...connectionPreview.input.shape };

export const metadata: ToolMetadata = {
  name: connectionPreview.name,
  description: connectionPreview.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function connectionPreviewTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  return invoke(connectionPreview.name, args, ctx, { surface: "mcp" });
}
