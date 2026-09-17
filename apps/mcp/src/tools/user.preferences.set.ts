import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { userPreferencesSet } from "@oxagen/oxagen/contracts/user.preferences.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = { ...userPreferencesSet.input.shape };

export const metadata: ToolMetadata = {
  name: userPreferencesSet.name,
  description: userPreferencesSet.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function setPreferencesTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(userPreferencesSet.name, args, ctx, {
    surface: "mcp",
  });
  return userPreferencesSet.output.parse(output);
}
