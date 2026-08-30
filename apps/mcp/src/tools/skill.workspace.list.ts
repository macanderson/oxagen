import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { skillWorkspaceList } from "@oxagen/oxagen/contracts/skill.workspace.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...skillWorkspaceList.input.shape,
  workspace_id: skillWorkspaceList.input.shape.workspace_id.describe(
    "Workspace ID (defaults to current workspace)",
  ),
};

export const metadata: ToolMetadata = {
  name: skillWorkspaceList.name,
  description: skillWorkspaceList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function skillWorkspaceListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(skillWorkspaceList.name, args, ctx, {
    surface: "mcp",
  });
  return skillWorkspaceList.output.parse(output);
}
