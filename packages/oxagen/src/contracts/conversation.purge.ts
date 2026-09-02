import { z } from "zod";
import { registerCapability } from "../registry";

// "Delete all archived" — bulk soft-delete of every archived conversation the
// caller owns in the scoped workspace. Same soft-delete semantics and
// irreversibility as conversation.delete (sets deleted_at on each archived
// row), so the UI ALWAYS confirms and the agent surface requires approval.
// Takes no ids: the set is "all of my archived conversations here", resolved
// server-side in one set-based UPDATE.
export const conversationPurge = registerCapability({
  name: "purge_conversations",
  domain: "conversation",
  description:
    "Permanently delete every archived conversation the caller owns in this workspace (soft-delete: sets deleted_at; rows retained for audit)",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "docs", "mcp", "unit", "app"],
  scoped: true,
  agent: {
    requiresApproval: true,
    riskLevel: "high",
    category: "conversation",
  },
  sensitivity: "destructive",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({}),
  output: z.object({
    deleted: z.number().int().nonnegative(),
  }),
});

export type ConversationPurgeInput = z.output<typeof conversationPurge.input>;
export type ConversationPurgeOutput = z.output<typeof conversationPurge.output>;
