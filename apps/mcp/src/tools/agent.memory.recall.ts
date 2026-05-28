import { agentMemoryRecall } from "@oxagen/oxagen/contracts/agent.memory.recall";
import { agentMemoryRecallHandler } from "@oxagen/agent/handlers/agent.memory.recall";
import { placeholderContext } from "../context.js";
import type { McpTool } from "../server.js";

export const agentMemoryRecallTool: McpTool = {
  name: agentMemoryRecall.name,
  description: agentMemoryRecall.description,
  invoke: async (raw) => {
    const input = agentMemoryRecall.input.parse(raw);
    const output = await agentMemoryRecallHandler(input, placeholderContext());
    return agentMemoryRecall.output.parse(output);
  },
};
