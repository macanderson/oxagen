import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { skillVersionGet } from "@oxagen/oxagen/contracts/skill.version.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...skillVersionGet.input.shape,
  skill_id: skillVersionGet.input.shape.skill_id.describe(
    "Public skill ID (skl_…) or slug that owns the version",
  ),
  version_id: skillVersionGet.input.shape.version_id.describe(
    "Public version ID (slv_…) to fetch; omit for the pinned active version",
  ),
};

export const metadata: ToolMetadata = {
  name: skillVersionGet.name,
  description: skillVersionGet.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function skillVersionGetTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(skillVersionGet.name, args, ctx, {
    surface: "mcp",
  });
  return skillVersionGet.output.parse(output);
}
