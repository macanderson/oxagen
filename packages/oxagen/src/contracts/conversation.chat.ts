import { z } from "zod";
import { registerCapability } from "../registry";

export const conversationChat = registerCapability({
  name: "conversation.chat",
  domain: "conversation",
  description: "Post a message to a conversation",
  mode: "sync",
  surfaces: ["api", "mcp", "cli"],
  layers: ["schema", "api", "mcp"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "conversation" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    conversation_id: z.string(),
    message: z.string().optional(),
  }),
  output: z.object({
    message_id: z.string(),
    created_at: z.string(),
    author: z.string(),
  }),
});

export type ConversationChatInput = z.output<typeof conversationChat.input>;
export type ConversationChatOutput = z.output<typeof conversationChat.output>;
