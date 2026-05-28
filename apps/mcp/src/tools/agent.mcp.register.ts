import { agentMcpRegister } from "@oxagen/oxagen/capabilities/agent.mcp.register";
import { agentMcpRegisterHandler } from "@oxagen/oxagen/capabilities/agent.mcp.register.handler";
import { placeholderContext } from "../context.js";
import type { McpTool } from "../server.js";

export const agentMcpRegisterTool: McpTool = {
  name: agentMcpRegister.name,
  description: agentMcpRegister.description,
  invoke: async (raw) => {
    const input = agentMcpRegister.input.parse(raw);
    const output = await agentMcpRegisterHandler(input, placeholderContext());
    return agentMcpRegister.output.parse(output);
  },
};
