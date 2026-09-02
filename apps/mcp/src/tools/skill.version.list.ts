import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { skillVersionList } from "@oxagen/oxagen/contracts/skill.version.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...skillVersionList.input.shape,
  skill_id: skillVersionList.input.shape.skill_id.describe(
    "Public skill ID (skl_…) whose version history to retrieve",
  ),
  limit: skillVersionList.input.shape.limit.describe(
    "Maximum number of versions to return (default 20, max 100)",
  ),
  offset: skillVersionList.input.shape.offset.describe(
    "Pagination offset — number of versions to skip",
  ),
};

export const metadata: ToolMetadata = {
  name: skillVersionList.name,
  description: skillVersionList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function skillVersionListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(skillVersionList.name, args, ctx, {
    surface: "mcp",
  });
  return skillVersionList.output.parse(output);
}
