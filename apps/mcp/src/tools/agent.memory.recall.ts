import { agentMemoryRecall } from "@oxagen/oxagen/capabilities/agent.memory.recall";
import { agentMemoryRecallHandler } from "@oxagen/oxagen/capabilities/agent.memory.recall.handler";
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
