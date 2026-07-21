import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { skillVersionUpload } from "@oxagen/oxagen/contracts/skill.version.upload";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  skill_id: skillVersionUpload.input.shape.skill_id.describe(
    "Public ID of the skill to add a version to (e.g. 'skl_...')",
  ),
  content: skillVersionUpload.input.shape.content.describe(
    "Canonical skill.toml content",
  ),
  activate: skillVersionUpload.input.shape.activate.describe(
    "Set this version as active immediately (default: true)",
  ),
  workspace_id: skillVersionUpload.input.shape.workspace_id.describe(
    "Workspace ID (defaults to current workspace)",
  ),
};

export const metadata: ToolMetadata = {
  name: skillVersionUpload.name,
  description: skillVersionUpload.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
  },
};

export default async function skillVersionUploadTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(skillVersionUpload.name, args, ctx, {
    surface: "mcp",
  });
  return skillVersionUpload.output.parse(output);
}
