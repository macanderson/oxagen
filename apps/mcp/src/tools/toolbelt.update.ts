import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { toolbeltUpdate } from "@oxagen/oxagen/contracts/toolbelt.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  toolbeltId: toolbeltUpdate.input.shape.toolbeltId.describe(
    "The custom belt to edit (tbt_…); the All tools belt cannot be edited",
  ),
  name: toolbeltUpdate.input.shape.name.describe("A new name"),
  description: toolbeltUpdate.input.shape.description.describe(
    "A new description, or null to clear it",
  ),
  changes: toolbeltUpdate.input.shape.changes.describe(
    "Applied in order: remove_server, add_server, set_server_active, set_tool_active. A null serverId names the declared tools",
  ),
};

export const metadata: ToolMetadata = {
  name: toolbeltUpdate.name,
  description: toolbeltUpdate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function toolbeltUpdateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(toolbeltUpdate.name, args, ctx, {
    surface: "mcp",
  });
  return toolbeltUpdate.output.parse(output);
}
