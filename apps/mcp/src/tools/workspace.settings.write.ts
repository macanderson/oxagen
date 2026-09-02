import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { workspaceSettingsWrite } from "@oxagen/oxagen/contracts/workspace.settings.write";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...workspaceSettingsWrite.input.shape,
};

export const metadata: ToolMetadata = {
  name: workspaceSettingsWrite.name,
  description: workspaceSettingsWrite.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function workspaceSettingsWriteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(workspaceSettingsWrite.name, args, ctx, {
    surface: "mcp",
  });
  return workspaceSettingsWrite.output.parse(output);
}
