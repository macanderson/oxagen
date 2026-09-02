import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentSkillLoad } from "@oxagen/oxagen/contracts/agent.skill.load";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentSkillLoad.input.shape,
  skillSlug: agentSkillLoad.input.shape.skillSlug.describe(
    "Slug of the skill to load",
  ),
  version: agentSkillLoad.input.shape.version.describe(
    "Version constraint: exact integer, '^N' (>=N), '~N' (=N). Omit for latest.",
  ),
};

export const metadata: ToolMetadata = {
  name: agentSkillLoad.name,
  description: agentSkillLoad.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentSkillLoadTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentSkillLoad.name, args, ctx, {
    surface: "mcp",
  });
  return agentSkillLoad.output.parse(output);
}
