import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * notifications.mark — mark a notification as read and/or archived.
 * Scoped to the acting user — users may only mark their own notifications.
 */
export const notificationsMark = registerCapability({
  name: "mark_notification",
  domain: "notification",
  description:
    "Mark a notification as read and/or archived for the calling user.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["api", "docs", "mcp", "unit", "app"],
  scoped: true,
  // Marking your own notification read is a settings write, never a governed
  // action (ADR-052 exclusion 2). The write is the record of the mark.
  noBillingGate: true,
  // Low risk, no approval, the same grade as archive_conversation. The call
  // changes only the calling person's own notification, and both flags take
  // false, so the person can undo it. The approval a notice announces stays
  // in Fleet's queue whatever the notice says.
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "notification",
  },
  sensitivity: "low",
  mutates: true,
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
    /** Public ID of the notification to update (e.g. "ntf_abc"). */
    id: z.string().min(1),
    /** When true, mark as read (unread = false). */
    read: z.boolean().optional(),
    /** When true, mark as archived. */
    archived: z.boolean().optional(),
  }),
  output: z.object({ ok: z.boolean() }),
});

export type NotificationsMarkInput = z.output<typeof notificationsMark.input>;
export type NotificationsMarkOutput = z.output<typeof notificationsMark.output>;
