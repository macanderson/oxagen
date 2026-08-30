import { z } from "zod";
import { registerCapability } from "../registry";

// The user-facing "delete" action. The engineering law forbids hard-deletes on
// org-scoped tables, so this sets deleted_at (soft-delete): the row is retained
// for SOC2/audit but disappears from every list — active AND archived — and is
// not restorable through any product surface. Because it is irreversible from
// the user's perspective, the UI ALWAYS gates it behind a confirm dialog and
// the agent surface requires approval. Set-based UPDATE over the id list.
export const conversationDelete = registerCapability({
  name: "delete_conversation",
  domain: "conversation",
  description:
    "Permanently delete conversations from the user's view (soft-delete: sets deleted_at; row retained for audit, never restorable)",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
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
  input: z.object({
    conversationIds: z.array(z.string().min(1)).min(1).max(100),
  }),
  output: z.object({
    deleted: z.number().int().nonnegative(),
  }),
});

export type ConversationDeleteInput = z.output<typeof conversationDelete.input>;
export type ConversationDeleteOutput = z.output<
  typeof conversationDelete.output
>;
