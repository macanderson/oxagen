import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { skillWorkspaceInstall } from "@oxagen/oxagen/contracts/skill.workspace.install";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  slug: skillWorkspaceInstall.input.shape.slug.describe(
    "Slug of a builtin skill template to install (e.g. 'summarization'). Mutually exclusive with `custom`.",
  ),
  custom: skillWorkspaceInstall.input.shape.custom.describe(
    "Custom skill definition to install. Mutually exclusive with `slug`.",
  ),
  workspace_id: skillWorkspaceInstall.input.shape.workspace_id.describe(
    "Ignored on this surface. The handler resolves the workspace from the " +
      "calling API key's request context, never from this field.",
  ),
};

export const metadata: ToolMetadata = {
  name: skillWorkspaceInstall.name,
  description: skillWorkspaceInstall.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function skillWorkspaceInstallTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(skillWorkspaceInstall.name, args, ctx, {
    surface: "mcp",
  });
  return skillWorkspaceInstall.output.parse(output);
}
