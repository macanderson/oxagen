import { z } from "zod";
import { registerCapability } from "../registry";

// One row in the conversation-history nav. Kept lean (title + lifecycle
// timestamps, no message preview) so listing N conversations is a single
// indexed scan with no per-row message join — the preview would be an N+1.
// Shared by the handler output, the API/MCP surfaces, and the app nav UI;
// import `ConversationSummary` rather than re-declaring the shape.
export const conversationSummary = z.object({
  publicId: z.string(),
  title: z.string().nullable(),
  status: z.string(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const conversationList = registerCapability({
  name: "list_conversations",
  domain: "conversation",
  description:
    "List a user's conversations in a workspace, filtered by active or archived state, newest first, keyset-paginated",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs", "app"],
  scoped: true,
  // Conversation listing does not consume AI tokens — billing gate must not
  // block this for orgs with zero credit balance.
  noBillingGate: true,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "conversation",
  },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z.object({
    // active = archived_at IS NULL; archived = archived_at IS NOT NULL.
    // Deleted (deleted_at) rows are never returned by either filter.
    filter: z.enum(["active", "archived"]).default("active"),
    limit: z.number().int().min(1).max(100).default(50),
    // Keyset cursor: ISO updated_at of the last row from the previous page.
    // Null starts at the newest row. Indexed by conversations_list_idx.
    cursor: z.string().nullable().default(null),
  }),
  output: z.object({
    conversations: z.array(conversationSummary),
    // Null when the page is the last one (fewer than `limit` rows returned).
    nextCursor: z.string().nullable(),
  }),
});

export type ConversationSummary = z.output<typeof conversationSummary>;
export type ConversationListInput = z.output<typeof conversationList.input>;
export type ConversationListOutput = z.output<typeof conversationList.output>;
