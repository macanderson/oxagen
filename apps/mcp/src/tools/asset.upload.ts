import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { assetUpload } from "@oxagen/oxagen/contracts/asset.upload";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...assetUpload.input.shape,
  sourceUrl: assetUpload.input.shape.sourceUrl.describe(
    "Publicly reachable https:// URL of the asset to ingest (SSRF-protected: private IP ranges and localhost are rejected). Must return a supported content type for the given kind.",
  ),
  kind: assetUpload.input.shape.kind.describe(
    'Asset category: "avatar"/"image" (webp/png/jpeg, max 5 MiB), "document" (image or PDF, max 25 MiB), or "video" (mp4/webm/quicktime, max 100 MiB).',
  ),
  source: assetUpload.input.shape.source.describe(
    'Omit for a pure public-blob ingest (no DB row). Pass "user_upload" to record a private generated_assets attachment row (accessPolicy=org) servable via /api/v1/assets/:publicId and listable via list_conversation_files. Requires an authenticated user; not valid for kind "avatar".',
  ),
  conversationId: assetUpload.input.shape.conversationId.describe(
    'Conversation public ID to link the uploaded asset to. Requires source="user_upload".',
  ),
};

export const metadata: ToolMetadata = {
  name: assetUpload.name,
  description: assetUpload.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function assetUploadTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(assetUpload.name, args, ctx, { surface: "mcp" });
  return assetUpload.output.parse(output);
}
