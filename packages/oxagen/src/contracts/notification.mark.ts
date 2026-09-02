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
  sensitivity: "low",
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
