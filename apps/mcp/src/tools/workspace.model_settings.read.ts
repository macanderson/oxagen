import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { workspaceModelSettingsRead } from "@oxagen/oxagen/contracts/workspace.model_settings.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {};

export const metadata: ToolMetadata = {
  name: workspaceModelSettingsRead.name,
  description: workspaceModelSettingsRead.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function workspaceModelSettingsReadTool(
  _args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(workspaceModelSettingsRead.name, {}, ctx, {
    surface: "mcp",
  });
  return workspaceModelSettingsRead.output.parse(output);
}
