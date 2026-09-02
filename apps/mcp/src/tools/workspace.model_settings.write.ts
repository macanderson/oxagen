import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { workspaceModelSettingsWrite } from "@oxagen/oxagen/contracts/workspace.model_settings.write";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...workspaceModelSettingsWrite.input.shape,
  defaultTextTier:
    workspaceModelSettingsWrite.input.shape.defaultTextTier.describe(
      "Workspace text model tier override (null clears the override)",
    ),
  defaultTextModel:
    workspaceModelSettingsWrite.input.shape.defaultTextModel.describe(
      "Explicit workspace text model id (null clears)",
    ),
  defaultImageModel:
    workspaceModelSettingsWrite.input.shape.defaultImageModel.describe(
      "Explicit workspace image model id (null clears)",
    ),
  defaultVideoModel:
    workspaceModelSettingsWrite.input.shape.defaultVideoModel.describe(
      "Explicit workspace video model id (null clears)",
    ),
};

export const metadata: ToolMetadata = {
  name: workspaceModelSettingsWrite.name,
  description: workspaceModelSettingsWrite.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function workspaceModelSettingsWriteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(workspaceModelSettingsWrite.name, args, ctx, {
    surface: "mcp",
  });
  return workspaceModelSettingsWrite.output.parse(output);
}
