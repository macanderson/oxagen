import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { userPreferencesUpdate } from "@oxagen/oxagen/contracts/user.preferences.update";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...userPreferencesUpdate.input.shape,
  theme: userPreferencesUpdate.input.shape.theme.describe(
    "UI theme (e.g. light, dark, system)",
  ),
  language: userPreferencesUpdate.input.shape.language.describe(
    "Preferred language code (e.g. en, fr)",
  ),
  timezone: userPreferencesUpdate.input.shape.timezone.describe(
    "Preferred timezone (e.g. America/New_York)",
  ),
};

export const metadata: ToolMetadata = {
  name: userPreferencesUpdate.name,
  description: userPreferencesUpdate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function userPreferencesUpdateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(userPreferencesUpdate.name, args, ctx, { surface: "mcp" });
  return userPreferencesUpdate.output.parse(output);
}
