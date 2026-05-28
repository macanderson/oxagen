import { agentTaskBackgroundRead } from "@oxagen/oxagen/capabilities/agent.task.background.read";
import { agentTaskBackgroundReadHandler } from "@oxagen/agent/handlers/agent.task.background.read";
import { placeholderContext } from "../context.js";
import type { McpTool } from "../server.js";

export const agentTaskBackgroundReadTool: McpTool = {
  name: agentTaskBackgroundRead.name,
  description: agentTaskBackgroundRead.description,
  invoke: async (raw) => {
    const input = agentTaskBackgroundRead.input.parse(raw);
    const output = await agentTaskBackgroundReadHandler(
      input,
      placeholderContext(),
    );
    return agentTaskBackgroundRead.output.parse(output);
  },
};
