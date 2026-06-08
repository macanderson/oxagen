import { z } from "zod";
import { registerCapability } from "../registry";
import { agentExecutionRecord } from "./agent.execution.record";

export const chatMessageExecution = registerCapability({
  name: "chat.message.execution",
  domain: "agent",
  description: "Record agent execution within a chat message context, linking execution lineage to conversation history",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  sensitivity: "low",
  defaultEffect: "allow",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: agentExecutionRecord.input.extend({
    originType: z.literal("chat").describe("Chat is the only origin type for message execution"),
    messageId: z.string().uuid().describe("Chat message ID to associate with this execution"),
    updateMessageMetadata: z.boolean().default(true).describe("Update message metadata with execution ID"),
  }),
  output: agentExecutionRecord.output,
});

export type ChatMessageExecutionInput = z.output<typeof chatMessageExecution.input>;
export type ChatMessageExecutionOutput = z.output<typeof chatMessageExecution.output>;
