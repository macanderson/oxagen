import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { userPreferencesRead } from "@oxagen/oxagen/contracts/user.preferences.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {};

export const metadata: ToolMetadata = {
  name: userPreferencesRead.name,
  description: userPreferencesRead.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function userPreferencesReadTool(
  _args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(userPreferencesRead.name, {}, ctx, {
    surface: "mcp",
  });
  return userPreferencesRead.output.parse(output);
}
