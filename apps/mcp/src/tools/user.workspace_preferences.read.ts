import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { userWorkspacePreferencesRead } from "@oxagen/oxagen/contracts/user.workspace_preferences.read";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {};

export const metadata: ToolMetadata = {
  name: userWorkspacePreferencesRead.name,
  description: userWorkspacePreferencesRead.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function userWorkspacePreferencesReadTool(
  _args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(userWorkspacePreferencesRead.name, {}, ctx, {
    surface: "mcp",
  });
  return userWorkspacePreferencesRead.output.parse(output);
}
