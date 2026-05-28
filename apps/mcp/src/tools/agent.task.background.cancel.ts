import { agentTaskBackgroundCancel } from "@oxagen/oxagen/contracts/agent.task.background.cancel";
import { agentTaskBackgroundCancelHandler } from "@oxagen/agent/handlers/agent.task.background.cancel";
import { placeholderContext } from "../context.js";
import type { McpTool } from "../server.js";

export const agentTaskBackgroundCancelTool: McpTool = {
  name: agentTaskBackgroundCancel.name,
  description: agentTaskBackgroundCancel.description,
  invoke: async (raw) => {
    const input = agentTaskBackgroundCancel.input.parse(raw);
    const output = await agentTaskBackgroundCancelHandler(
      input,
      placeholderContext(),
    );
    return agentTaskBackgroundCancel.output.parse(output);
  },
};
