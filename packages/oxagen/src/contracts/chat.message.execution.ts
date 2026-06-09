import { z } from "zod";
import { registerCapability } from "../registry";
import { agentExecutionRecord } from "./agent.execution.record";

export const chatMessageExecution = registerCapability({
  name: "chat.message.execution",
  description:
    "Record agent execution within a chat message context, linking execution lineage to conversation history",

  input: agentExecutionRecord.input.extend({
    originType: z.literal("chat").describe("Chat is the only origin type for message execution"),
    messageId: z.string().uuid().describe("Chat message ID to associate with this execution"),
    updateMessageMetadata: z.boolean().default(true).describe("Update message metadata with execution ID"),
  }),

  output: agentExecutionRecord.output,

  surfaces: ["api", "mcp"],
});
