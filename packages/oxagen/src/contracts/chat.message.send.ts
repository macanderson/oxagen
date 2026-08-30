import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * Upper bound for a single user chat message, shared by EVERY chat ingress
 * (this contract → MCP, the app chat route, the REST API chat route). An
 * unbounded `content` lets a single authed request forward an arbitrarily
 * large prompt to the LLM, driving unbounded metering cost and blowing the
 * per-turn token budget. 32 KiB is generous for a chat turn while capping
 * abuse.
 */
export const CHAT_CONTENT_MAX_CHARS = 32_768;

// Streaming response is delivered via the AI SDK; the capability's output
// schema describes the *terminal* message persisted after the stream
// completes. The HTTP route emits an SSE / RSC stream that resolves to
// this shape.
export const chatMessageSend = registerCapability({
  name: "send_message",
  domain: "chat",
  description:
    "Append a user message to a conversation and stream the assistant reply",
  mode: "async",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    conversationId: z.string().nullable(),
    parentMessageId: z.string().nullable(),
    branchReason: z
      .enum(["edit", "regenerate", "tool_retry", "manual_fork"])
      .nullable(),
    content: z.string().min(1).max(CHAT_CONTENT_MAX_CHARS),
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
