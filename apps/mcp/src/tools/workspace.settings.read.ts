import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { workspaceSettingsRead } from "@oxagen/oxagen/contracts/workspace.settings.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {};

export const metadata: ToolMetadata = {
  name: workspaceSettingsRead.name,
  description: workspaceSettingsRead.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function workspaceSettingsReadTool(
  _args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(workspaceSettingsRead.name, {}, ctx, {
    surface: "mcp",
  });
  return workspaceSettingsRead.output.parse(output);
}
