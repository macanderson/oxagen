import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { toolStudioServerGet } from "@oxagen/oxagen/contracts/tool.studio.server.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  server: toolStudioServerGet.input.shape.server.describe(
    "The server folder under tools/servers/ to read",
  ),
};

export const metadata: ToolMetadata = {
  name: toolStudioServerGet.name,
  description: toolStudioServerGet.description,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
};

export default async function toolStudioServerGetTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(toolStudioServerGet.name, args, ctx, { surface: "mcp" });
  return toolStudioServerGet.output.parse(output);
}
