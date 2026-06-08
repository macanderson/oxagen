import { defineCapability, z } from "@oxagen/oxagen/core";
import { agentExecutionRecord } from "./agent.execution.record";

export const chatMessageExecution = defineCapability({
  name: "chat.message.execution",
  displayName: "Record Chat Message Execution",
  description:
    "Record agent execution within a chat message context, linking execution lineage to conversation history",

  input: agentExecutionRecord.input.extend({
    messageId: z.string().uuid().describe("Chat message ID to associate with this execution"),
    updateMessageMetadata: z.boolean().default(true).describe("Update message metadata with execution ID"),
  }),

  output: agentExecutionRecord.output,

  surfaces: ["api", "mcp"],
});
