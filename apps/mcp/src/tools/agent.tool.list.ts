import { agentToolList } from "@oxagen/oxagen/capabilities/agent.tool.list";
import { agentToolListHandler } from "@oxagen/oxagen/capabilities/agent.tool.list.handler";
import { placeholderContext } from "../context.js";
import type { McpTool } from "../server.js";

export const agentToolListTool: McpTool = {
  name: agentToolList.name,
  description: agentToolList.description,
  invoke: async (raw) => {
    const input = agentToolList.input.parse(raw ?? {});
    const output = await agentToolListHandler(input, placeholderContext());
    return agentToolList.output.parse(output);
  },
};
