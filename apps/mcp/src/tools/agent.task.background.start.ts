import { agentTaskBackgroundStart } from "@oxagen/oxagen/capabilities/agent.task.background.start";
import { agentTaskBackgroundStartHandler } from "@oxagen/agent/handlers/agent.task.background.start";
import { placeholderContext } from "../context.js";
import type { McpTool } from "../server.js";

export const agentTaskBackgroundStartTool: McpTool = {
  name: agentTaskBackgroundStart.name,
  description: agentTaskBackgroundStart.description,
  invoke: async (raw) => {
    const input = agentTaskBackgroundStart.input.parse(raw);
    // Zod infers `payload` as optional; the handler's hand-written interface
    // marks it required. Bridge the inference gap.
    const output = await agentTaskBackgroundStartHandler(
      input as unknown as Parameters<typeof agentTaskBackgroundStartHandler>[0],
      placeholderContext(),
    );
    return agentTaskBackgroundStart.output.parse(output);
  },
};
