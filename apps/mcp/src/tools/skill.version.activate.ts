import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { skillVersionActivate } from "@oxagen/oxagen/contracts/skill.version.activate";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...skillVersionActivate.input.shape,
  skillId: skillVersionActivate.input.shape.skillId.describe(
    "Public ID of the skill to update (e.g. 'skl_...')",
  ),
  versionNumber: skillVersionActivate.input.shape.versionNumber.describe(
    "Version number to set as active (can be an older version to roll back)",
  ),
};

export const metadata: ToolMetadata = {
  name: skillVersionActivate.name,
  description: skillVersionActivate.description,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function skillVersionActivateTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(skillVersionActivate.name, args, ctx, {
    surface: "mcp",
  });
  return skillVersionActivate.output.parse(output);
}
