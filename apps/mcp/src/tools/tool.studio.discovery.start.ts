import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { toolStudioDiscoveryStart } from "@oxagen/oxagen/contracts/tool.studio.discovery.start";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  server: toolStudioDiscoveryStart.input.shape.server.describe(
    "The server folder under tools/servers/ whose tools to discover now",
  ),
};

export const metadata: ToolMetadata = {
  name: toolStudioDiscoveryStart.name,
  description: toolStudioDiscoveryStart.description,
  // Each call queues another discovery, and a changed tool list opens or
  // updates the sync steering PR, so a repeat is not a no-op.
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
};

export default async function toolStudioDiscoveryStartTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(toolStudioDiscoveryStart.name, args, ctx, { surface: "mcp" });
  return toolResult(toolStudioDiscoveryStart.output.parse(output));
}
