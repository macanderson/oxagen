import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { toolStudioToolsList } from "@oxagen/oxagen/contracts/tool.studio.tools.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  server: toolStudioToolsList.input.shape.server.describe(
    "The server folder under tools/servers/ whose imported and available tools to list",
  ),
};

export const metadata: ToolMetadata = {
  name: toolStudioToolsList.name,
  description: toolStudioToolsList.description,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
};

export default async function toolStudioToolsListTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(toolStudioToolsList.name, args, ctx, { surface: "mcp" });
  return toolResult(toolStudioToolsList.output.parse(output));
}
