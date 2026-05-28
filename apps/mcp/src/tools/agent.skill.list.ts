import { agentSkillList } from "@oxagen/oxagen/contracts/agent.skill.list";
import { agentSkillListHandler } from "@oxagen/agent/handlers/agent.skill.list";
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
