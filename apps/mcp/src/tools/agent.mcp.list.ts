import { agentMcpList } from "@oxagen/oxagen/capabilities/agent.mcp.list";
import { agentMcpListHandler } from "@oxagen/oxagen/capabilities/agent.mcp.list.handler";
import { placeholderContext } from "../context.js";
import type { McpTool } from "../server.js";

export const agentMcpListTool: McpTool = {
  name: agentMcpList.name,
  description: agentMcpList.description,
  invoke: async (raw) => {
    const input = agentMcpList.input.parse(raw ?? {});
    const output = await agentMcpListHandler(input, placeholderContext());
    return agentMcpList.output.parse(output);
  },
};
