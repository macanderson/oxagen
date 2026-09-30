import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { toolStudioDiscoveryGet } from "@oxagen/oxagen/contracts/tool.studio.discovery.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  server: toolStudioDiscoveryGet.input.shape.server.describe(
    "The server folder under tools/servers/ whose latest discovery to read",
  ),
};

export const metadata: ToolMetadata = {
  name: toolStudioDiscoveryGet.name,
  description: toolStudioDiscoveryGet.description,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
};

export default async function toolStudioDiscoveryGetTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(toolStudioDiscoveryGet.name, args, ctx, { surface: "mcp" });
  return toolStudioDiscoveryGet.output.parse(output);
}
