import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { userPreferencesWrite } from "@oxagen/oxagen/contracts/user.preferences.write";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...userPreferencesWrite.input.shape,
  fontSize: userPreferencesWrite.input.shape.fontSize.describe(
    "UI text size preference",
  ),
  density: userPreferencesWrite.input.shape.density.describe(
    "UI density preference",
  ),
  enterToSubmit: userPreferencesWrite.input.shape.enterToSubmit.describe(
    "When true, Enter submits; otherwise Enter inserts a newline",
  ),
  pendingPromptBehavior:
    userPreferencesWrite.input.shape.pendingPromptBehavior.describe(
      "What to do with a new prompt while a response is in flight",
    ),
  defaultTextTier: userPreferencesWrite.input.shape.defaultTextTier.describe(
    "Preferred text model tier (null clears the preference)",
  ),
  defaultTextModel: userPreferencesWrite.input.shape.defaultTextModel.describe(
    "Explicit text model id, e.g. 'anthropic/claude-opus-4.8' (null clears)",
  ),
  defaultImageModel:
    userPreferencesWrite.input.shape.defaultImageModel.describe(
      "Explicit image model id, e.g. 'bfl/flux-2-max' (null clears)",
    ),
  defaultVideoModel:
    userPreferencesWrite.input.shape.defaultVideoModel.describe(
      "Explicit video model id, e.g. 'google/veo-3.0-generate-001' (null clears)",
    ),
};

export const metadata: ToolMetadata = {
  name: userPreferencesWrite.name,
  description: userPreferencesWrite.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function userPreferencesWriteTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(userPreferencesWrite.name, args, ctx, {
    surface: "mcp",
  });
  return userPreferencesWrite.output.parse(output);
}
