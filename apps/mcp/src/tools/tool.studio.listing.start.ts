import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { toolStudioListingStart } from "@oxagen/oxagen/contracts/tool.studio.listing.start";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  server: toolStudioListingStart.input.shape.server.describe(
    "The server folder under tools/servers/ whose draft's tools a machine lists",
  ),
  revision: toolStudioListingStart.input.shape.revision.describe(
    "The draft revision you read. A draft saved since then is refused",
  ),
  pin: toolStudioListingStart.input.shape.pin.describe(
    "A local command's version and sha256:<hex> of the executable. Omit it for a registry package",
  ),
};

export const metadata: ToolMetadata = {
  name: toolStudioListingStart.name,
  description: toolStudioListingStart.description,
  // It starts the pinned server on a machine, and each call replaces the
  // draft's listing, so a repeat is not a no-op.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export default async function toolStudioListingStartTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(toolStudioListingStart.name, args, ctx, { surface: "mcp" });
  return toolResult(toolStudioListingStart.output.parse(output));
}
