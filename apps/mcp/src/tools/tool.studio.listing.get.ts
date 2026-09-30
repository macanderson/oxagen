import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { toolStudioListingGet } from "@oxagen/oxagen/contracts/tool.studio.listing.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  server: toolStudioListingGet.input.shape.server.describe(
    "The server folder under tools/servers/ whose draft's listing to read",
  ),
};

export const metadata: ToolMetadata = {
  name: toolStudioListingGet.name,
  description: toolStudioListingGet.description,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
};

export default async function toolStudioListingGetTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(toolStudioListingGet.name, args, ctx, { surface: "mcp" });
  return toolStudioListingGet.output.parse(output);
}
