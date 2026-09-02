import { z } from "zod";
import { registerCapability } from "../registry";

// Set a conversation's title. Reversible, low-risk metadata edit — the
// long-press / double-click action menu in the history nav offers it so a
// user can name an otherwise "New conversation" row.
export const conversationRename = registerCapability({
  name: "rename_conversation",
  domain: "conversation",
  description: "Rename a conversation (set its title)",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "docs", "mcp", "unit", "app"],
  scoped: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "conversation",
  },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    // The cnv_ public id — the same identifier the URL (?c=) and the nav carry.
    conversationId: z.string().min(1),
    title: z.string().trim().min(1).max(200),
  }),
  output: z.object({
    publicId: z.string(),
    title: z.string(),
  }),
});

export type ConversationRenameInput = z.output<typeof conversationRename.input>;
export type ConversationRenameOutput = z.output<
  typeof conversationRename.output
>;
