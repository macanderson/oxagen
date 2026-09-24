import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * The MC spec §7.7 events a notification may report, restricted to the names
 * with a producer in this release: approval.requested (createApprovalRequest),
 * approval.resolved (resolve_approval), budget.breached (the spend-budget
 * gate at 100%). The database CHECK carries the same list.
 */
export const NOTIFICATION_EVENTS = [
  "approval.requested",
  "approval.resolved",
  "budget.breached",
] as const;

/**
 * notifications.list — list the calling user's in-app notifications.
 * Scoped to the acting user (ctx.userId); workspace-scoped for context.
 * Any org member may read their own notifications (Owner/Admin/Member/Viewer).
 */
export const notificationsList = registerCapability({
  name: "list_notifications",
  domain: "notification",
  description:
    "List in-app notifications for the calling user. Supports filtering to unread-only and pagination.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["api", "docs", "mcp", "unit", "app"],
  scoped: true,
  // A console read is never a governed action (ADR-052 exclusion 2).
  noBillingGate: true,
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: {
      Owner: "allow",
      Admin: "allow",
      Compliance: "allow",
      Billing: "allow",
    },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({
    unreadOnly: z.boolean().optional().default(false),
    limit: z.number().int().min(1).max(100).default(50),
  }),
  output: z.object({
    notifications: z.array(
      z.object({
        id: z.string(),
        publicId: z.string(),
        kind: z.enum(["system", "approval", "run", "member", "security"]),
        /** The §7.7 event that produced the row; null for rows no event produced. */
        event: z.enum(NOTIFICATION_EVENTS).nullable(),
        title: z.string(),
        body: z.string().nullable(),
        deepLink: z.string().nullable(),
        unread: z.boolean(),
        archived: z.boolean(),
        createdAt: z.string(), // ISO8601
      }),
    ),
    unreadCount: z.number().int().nonnegative(),
  }),
});

export type NotificationsListInput = z.output<typeof notificationsList.input>;
export type NotificationsListOutput = z.output<typeof notificationsList.output>;
