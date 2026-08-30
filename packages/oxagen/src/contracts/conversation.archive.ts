import { z } from "zod";
import { registerCapability } from "../registry";

// Toggle the archive state of one or more conversations. Archiving is the
// reversible soft state (sets/clears archived_at): archived conversations
// leave the active history list but stay restorable, so the UI runs it
// WITHOUT a confirm dialog. Distinct from conversation.delete, which is the
// permanent (soft-delete) destructive path. Set-based UPDATE over the id
// list — no per-item round trip.
export const conversationArchive = registerCapability({
  name: "archive_conversation",
  domain: "conversation",
  description:
    "Archive or unarchive conversations (reversible — sets or clears archived_at, no data loss)",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "conversation",
  },
  // Reversible state change — not destructive despite being a write.
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    conversationIds: z.array(z.string().min(1)).min(1).max(100),
    // true → archive (set archived_at); false → restore (clear archived_at).
    archived: z.boolean(),
  }),
  output: z.object({
    updated: z.number().int().nonnegative(),
  }),
});

export type ConversationArchiveInput = z.output<
  typeof conversationArchive.input
>;
export type ConversationArchiveOutput = z.output<
  typeof conversationArchive.output
>;
