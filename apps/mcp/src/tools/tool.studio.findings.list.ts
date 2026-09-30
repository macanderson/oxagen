import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { toolStudioFindingsList } from "@oxagen/oxagen/contracts/tool.studio.findings.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  server: toolStudioFindingsList.input.shape.server.describe(
    "The server folder under tools/servers/ to check: its saved draft, or the production folder when it has no draft",
  ),
};

export const metadata: ToolMetadata = {
  name: toolStudioFindingsList.name,
  description: toolStudioFindingsList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function toolStudioFindingsListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(toolStudioFindingsList.name, args, ctx, {
    surface: "mcp",
  });
  return toolStudioFindingsList.output.parse(output);
}
