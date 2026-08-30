import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { archiveCreate } from "@oxagen/oxagen/contracts/archive.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

// ZIP archive creation from existing generated assets, inline base64 blobs,
// or plain text entries. Built in-process with fflate; no cloud calls required.

export const schema = {
  ...archiveCreate.input.shape,
  archiveName: archiveCreate.input.shape.archiveName.describe(
    "Desired filename for the ZIP archive (without .zip extension)",
  ),
  entries: archiveCreate.input.shape.entries.describe(
    "Items to bundle. Each entry must supply exactly one of: assetId (publicId of an existing generated asset), contentBase64 (raw bytes as base64), or text (UTF-8 string)",
  ),
};

export const metadata: ToolMetadata = {
  name: archiveCreate.name,
  description: archiveCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function archiveCreateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(archiveCreate.name, args, ctx, {
    surface: "mcp",
  });
  return archiveCreate.output.parse(output);
}
