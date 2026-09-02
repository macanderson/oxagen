import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { skillEnable } from "@oxagen/oxagen/contracts/skill.enable";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  skill_id: skillEnable.input.shape.skill_id.describe(
    "Public ID of the skill (skl_...) or its slug",
  ),
  enabled: skillEnable.input.shape.enabled.describe(
    "true to enable, false to disable",
  ),
  workspace_id: skillEnable.input.shape.workspace_id.describe(
    "Ignored on this surface. The handler resolves the workspace from the " +
      "calling API key's request context, never from this field.",
  ),
};

export const metadata: ToolMetadata = {
  name: skillEnable.name,
  description: skillEnable.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function skillEnableTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(skillEnable.name, args, ctx, { surface: "mcp" });
  return skillEnable.output.parse(output);
}
