import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { toolStudioDraftGet } from "@oxagen/oxagen/contracts/tool.studio.draft.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";
import { toolResult } from "../tool-result";

export const schema = {
  server: toolStudioDraftGet.input.shape.server.describe(
    "The server folder under tools/servers/ whose draft to read",
  ),
};

export const metadata: ToolMetadata = {
  name: toolStudioDraftGet.name,
  description: toolStudioDraftGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function toolStudioDraftGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(toolStudioDraftGet.name, args, ctx, {
    surface: "mcp",
  });
  return toolResult(toolStudioDraftGet.output.parse(output));
}
