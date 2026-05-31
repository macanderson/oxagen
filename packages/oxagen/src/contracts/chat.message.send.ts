import { z } from "zod";
import { registerCapability } from "../registry.js";

// Streaming response is delivered via the AI SDK; the capability's output
// schema describes the *terminal* message persisted after the stream
// completes. The HTTP route emits an SSE / RSC stream that resolves to
// this shape.
export const chatMessageSend = registerCapability({
  name: "chat.message.send",
  domain: "chat",
  description: "Append a user message to a conversation and stream the assistant reply",
  mode: "async",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  input: z.object({
    conversationId: z.string().nullable(),
    agentVersionId: z.string().nullable(),
    parentMessageId: z.string().nullable(),
    branchReason: z.enum(["edit", "regenerate", "tool_retry", "manual_fork"]).nullable(),
    content: z.string().min(1),
    contentBlocks: z.array(z.unknown()).default([]),
  }),
  output: z.object({
    conversationId: z.string(),
    userMessageId: z.string(),
    assistantMessageId: z.string(),
    activeLeafMessageId: z.string(),
  }),
});

export type ChatMessageSendInput = z.output<typeof chatMessageSend.input>;
export type ChatMessageSendOutput = z.output<typeof chatMessageSend.output>;
