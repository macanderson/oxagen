import { z } from "zod";
import { defineTool } from "./_define";
import { notificationsMark } from "../notification.mark";

/**
 * Appendix E: `mark_notification`. Absorbs `mark_notification`. One source,
 * empty `Does` column, clean 1:1 carry, `drops` is `[]`.
 *
 * **Why this is its own tool rather than an argument on `list_notifications`.**
 * The Assistant and account family folds actions into their list tool elsewhere
 * — `list_conversations` carries rename, archive, delete, export and purge as
 * arguments. Appendix E deliberately does not do that here, and the reason is
 * visible in the grades: every conversation action shares the conversation's
 * destructive ceiling, whereas marking a notification read is the lowest-risk
 * write in the product. Folding it into the list would have dragged the list
 * up to the write's grade for no gain, and unlike the conversation actions it
 * is not an action menu on a row — it is what the UI does automatically when a
 * row scrolls into view.
 *
 * **Both flags stay optional.** A call with neither is a no-op, which is
 * deliberate: the two flags are independent (read and archived are different
 * columns), and requiring at least one would mean a caller archiving a row it
 * already read has to restate the read state and risk clobbering it.
 */
export const markNotification = defineTool({
  name: "mark_notification",
  domain: "assistant",
  description:
    "Mark one of the calling user's notifications as read and/or archived.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["api", "docs", "mcp", "unit"],
  scoped: true,
  // Same reasoning as `list_notifications`: clearing one's own notification
  // badge burns no model tokens, and an org at zero balance should not be left
  // with an unclearable approval notice.
  noBillingGate: true,

  absorbs: ["mark_notification"],
  drops: [],

  // v1 declared no agent metadata; added for the same reason as
  // `list_notifications` — the tool is reachable from a model, so it needs a
  // grade. The write is confined to the caller's own rows.
  agent: { requiresApproval: false, riskLevel: "low", category: "user" },
  sensitivity: "low",
  defaultEffect: "deny",
  // Carried unchanged, and wide for the same reason as `list_notifications`:
  // the handler scopes every row to `ctx.userId`, so a principal can only ever
  // mark its own.
  defaultRoles: {
    org: {
      Owner: "allow",
      Admin: "allow",
      Compliance: "allow",
      Billing: "allow",
    },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  // Writes the notification row. Trivially, but a write.
  mutates: true,

  input: z.object({
    /** The `ntf_` public id, never the internal row id. */
    id: notificationsMark.input.shape.id,
    read: notificationsMark.input.shape.read,
    archived: notificationsMark.input.shape.archived,
  }),

  output: z.object({
    ok: notificationsMark.output.shape.ok,
  }),
});

export type MarkNotificationInput = z.output<typeof markNotification.input>;
export type MarkNotificationOutput = z.output<typeof markNotification.output>;
