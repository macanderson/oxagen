import { type InferSchema, type ToolMetadata } from "xmcp";
import { headers } from "xmcp/headers";
import { agentSkillList } from "@oxagen/oxagen/contracts/agent.skill.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { buildContext } from "../context";

export const schema = {
  ...agentSkillList.input.shape,
  filter: agentSkillList.input.shape.filter.describe(
    "Optional name/slug filter",
  ),
};

export const metadata: ToolMetadata = {
  name: agentSkillList.name,
  description: agentSkillList.description,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
  },
};

export default async function agentSkillListTool(
  args: InferSchema<typeof schema>,
) {
  const ctx = await buildContext(headers());
  const output = await invoke(agentSkillList.name, args, ctx, {
    surface: "mcp",
  });
  return agentSkillList.output.parse(output);
}
