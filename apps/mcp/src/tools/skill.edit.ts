import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { skillEdit } from "@oxagen/oxagen/contracts/skill.edit";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  skill_id: skillEdit.input.shape.skill_id.describe(
    "Public ID of the skill to edit (e.g. 'skl_...')",
  ),
  body: skillEdit.input.shape.body.describe(
    "Full updated .skill.md content including YAML frontmatter",
  ),
  activate: skillEdit.input.shape.activate.describe(
    "Set the new version as active immediately (default: true)",
  ),
  workspace_id: skillEdit.input.shape.workspace_id.describe(
    "Workspace ID (defaults to current workspace)",
  ),
};

export const metadata: ToolMetadata = {
  name: skillEdit.name,
  description: skillEdit.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function skillEditTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(skillEdit.name, args, ctx, { surface: "mcp" });
  return skillEdit.output.parse(output);
}
