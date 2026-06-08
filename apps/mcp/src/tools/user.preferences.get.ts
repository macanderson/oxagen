import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { userPreferencesGet } from "@oxagen/oxagen/contracts/user.preferences.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {};

export const metadata: ToolMetadata = {
  name: userPreferencesGet.name,
  description: userPreferencesGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function userPreferencesGetTool(
  _args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(userPreferencesGet.name, {}, ctx, { surface: "mcp" });
  return userPreferencesGet.output.parse(output);
}
