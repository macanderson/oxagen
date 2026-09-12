import { z } from "zod";
import { defineTool } from "./_define";
import { notificationsList } from "../notification.list";

/**
 * Appendix E: `list_notifications`. Absorbs `list_notifications`. Empty `Does`
 * column and a single source, so the v1 job carries whole and `drops` is `[]`.
 *
 * **Why it survives at all.** §7.5 says an approval request "notifies (Mission
 * Control, Slack, email)", and §14 makes approvals a panel on Fleet and a strip
 * on Run rather than a page. The in-app notification is the Mission Control
 * half of that notify, and the `kind` enum already carries the four things the
 * product raises — `approval`, `run`, `security`, `member` — plus `system`.
 *
 * **Why `deepLink` matters more in v2 than it did in v1.** §14's interaction
 * rules: "Every explanation is a chain of links to frames, records, and
 * commits, not a summary." A notification with a body and no link is a summary.
 * The field is carried nullable as v1 had it, because `system` notices legitimately
 * have nowhere to point, but every `approval` and `run` notice should.
 */
export const listNotifications = defineTool({
  name: "list_notifications",
  domain: "assistant",
  description:
    "List in-app notifications for the calling user, optionally unread-only, with the unread count.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["api", "docs", "mcp", "unit"],
  scoped: true,
  /**
   * New in v2. v1 did not set it, which means an org at zero credit balance
   * stops being told that an agent is parked waiting for an approval — the
   * moment it most needs to be told. Reading one's own notifications consumes
   * no model tokens, so the gate has nothing to protect here.
   */
  noBillingGate: true,

  absorbs: ["list_notifications"],
  drops: [],

  /**
   * v1 declared no agent metadata. Added, because the tool is on the MCP and
   * agent surfaces and every capability reachable from a model needs a grade:
   * low and introspective — it reads the caller's own notifications and can
   * reach nothing else.
   */
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  defaultEffect: "deny",
  /**
   * Carried unchanged, including the unusually wide org map. It is wide on
   * purpose: notifications are scoped to the acting user by `ctx.userId`, so a
   * Billing or Compliance principal reading this sees only their own, and
   * `security` and `approval` notices are exactly what those roles exist for.
   */
  defaultRoles: {
    org: {
      Owner: "allow",
      Admin: "allow",
      Compliance: "allow",
      Billing: "allow",
    },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  /**
   * Read-only, confirmed against `packages/handlers/src/notification.list.ts`:
   * selects only, and in particular it does not mark rows read as a side effect
   * of listing them — that is `mark_notification`'s job, which is why the two
   * stayed separate tools in Appendix E.
   */
  mutates: false,

  input: z.object({
    unreadOnly: notificationsList.input.shape.unreadOnly,
    limit: notificationsList.input.shape.limit,
  }),

  output: z.object({
    /** Carried whole: id, publicId, kind, title, body, deepLink, unread, archived, createdAt. */
    notifications: notificationsList.output.shape.notifications,
    /**
     * The badge count. Not derivable from `notifications.length` — that is one
     * page, and the count is over every unread row.
     */
    unreadCount: notificationsList.output.shape.unreadCount,
  }),
});

export type ListNotificationsInput = z.output<typeof listNotifications.input>;
export type ListNotificationsOutput = z.output<typeof listNotifications.output>;
