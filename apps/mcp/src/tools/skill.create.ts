import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { skillCreate } from "@oxagen/oxagen/contracts/skill.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  content: skillCreate.input.shape.content.describe(
    "Canonical skill.toml content",
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

export default async function skillCreateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(skillCreate.name, args, ctx, { surface: "mcp" });
  return skillCreate.output.parse(output);
}
