import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { skillCreate } from "@oxagen/oxagen/contracts/skill.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  name: skillCreate.input.shape.name.describe("Human-readable name for the skill"),
  slug: skillCreate.input.shape.slug.describe(
    "Unique kebab-case identifier (a-z, 0-9, hyphens) for the skill within this workspace",
  ),
  description: skillCreate.input.shape.description.describe(
    "Short description of what the skill teaches the agent",
  ),
  body: skillCreate.input.shape.body.describe(
    "Full .skill.md content (YAML frontmatter + markdown body)",
  ),
  activate: skillCreate.input.shape.activate.describe(
    "Set the initial version as active immediately (default: true)",
  ),
  workspace_id: skillCreate.input.shape.workspace_id.describe(
    "Workspace ID (defaults to current workspace)",
  ),
};

export const metadata: ToolMetadata = {
  name: skillCreate.name,
  description: skillCreate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function skillCreateTool(args: InferSchema<typeof schema>) {
  const ctx = await buildContext(headers());
  const output = await invoke(skillCreate.name, args, ctx, { surface: "mcp" });
  return skillCreate.output.parse(output);
}
