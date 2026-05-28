import { agentMemoryWrite } from "@oxagen/oxagen/capabilities/agent.memory.write";
import { agentMemoryWriteHandler } from "@oxagen/agent/handlers/agent.memory.write";
import { placeholderContext } from "../context.js";
import type { McpTool } from "../server.js";

export const agentMemoryWriteTool: McpTool = {
  name: agentMemoryWrite.name,
  description: agentMemoryWrite.description,
  invoke: async (raw) => {
    const input = agentMemoryWrite.input.parse(raw);
    const output = await agentMemoryWriteHandler(input, placeholderContext());
    return agentMemoryWrite.output.parse(output);
  },
};
