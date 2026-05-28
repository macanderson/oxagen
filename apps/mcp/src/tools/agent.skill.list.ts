import { agentSkillList } from "@oxagen/oxagen/capabilities/agent.skill.list";
import { agentSkillListHandler } from "@oxagen/oxagen/capabilities/agent.skill.list.handler";
import { placeholderContext } from "../context.js";
import type { McpTool } from "../server.js";

export const agentSkillListTool: McpTool = {
  name: agentSkillList.name,
  description: agentSkillList.description,
  invoke: async (raw) => {
    const input = agentSkillList.input.parse(raw ?? {});
    const output = await agentSkillListHandler(input, placeholderContext());
    return agentSkillList.output.parse(output);
  },
};
