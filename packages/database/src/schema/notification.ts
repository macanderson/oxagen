import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { notificationSchema } from "./_schemas";
import { auditMixin, idMixin } from "./_mixins";

/**
 * The MC spec §7.7 events a notification row may report, restricted to the
 * names that have a producer (migration 20260915206000_notification_events).
 * The drizzle CHECK below is built from this list. `list_notifications`
 * publishes the same list as `NOTIFICATION_EVENTS`, and
 * notification-events.test.ts holds the contract's list, this list and the
 * CHECK the latest migration writes equal.
 */
export const NOTIFICATION_EVENT_VALUES = [
  "approval.requested",
  "approval.resolved",
  "budget.breached",
] as const;
export type NotificationEventValue = (typeof NOTIFICATION_EVENT_VALUES)[number];

/**
 * notification.notifications — in-app notification feed (also mirrored to email
 * for certain kinds). The MCP re-auth flow (Plan 5) is the first producer; the
 * table is generic so approval/run/security kinds can reuse it.
 */
export const notifications = notificationSchema.table(
  "notifications",
  {
    ...idMixin("ntf"),
    ...auditMixin(),
    orgId: uuid("org_id").notNull(),
    workspaceId: uuid("workspace_id"),
    userId: uuid("user_id").notNull(),
    kind: text("kind").notNull(), // system | approval | run | member | security
    /** The §7.7 event that produced the row; null for rows no event produced. */
    event: text("event").$type<NotificationEventValue>(),
    title: text("title").notNull(),
    body: text("body"),
    deepLink: text("deep_link"),
    unread: boolean("unread").notNull().default(true),
    archived: boolean("archived").notNull().default(false),
    emailedAt: timestamp("emailed_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    // Partial index for the unread-feed query — excludes archived rows so the
    // index stays small and matches the feed's WHERE NOT archived predicate.
    userUnreadIdx: index("notifications_user_unread_idx")
      .on(t.userId, t.unread)
      .where(sql`${t.archived} = false`),
    // The feed list filters (user_id, org_id, archived=false [, unread=true])
    // and ORDER BYs created_at DESC (notifications.list). The (user_id, unread)
    // partial index above covers neither org_id nor the created_at sort; this
    // partial composite matches the feed predicate and serves the sort.
    userOrgCreatedIdx: index("notifications_user_org_created_idx")
      .on(t.userId, t.orgId, t.createdAt)
      .where(sql`${t.archived} = false`),
    orgIdx: index("notifications_org_idx").on(t.orgId),
    kindCheck: check(
      "notifications_kind_check",
      sql`${t.kind} IN ('system','approval','run','member','security')`,
    ),
    eventCheck: check(
      "notifications_event_check",
      sql`${t.event} IS NULL OR ${t.event} IN (${sql.raw(NOTIFICATION_EVENT_VALUES.map((v) => `'${v}'`).join(", "))})`,
    ),
  }),
);
