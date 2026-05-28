import { agentMcpRegister } from "@oxagen/oxagen/contracts/agent.mcp.register";
import { agentMcpRegisterHandler } from "@oxagen/agent/handlers/agent.mcp.register";
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
