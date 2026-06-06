import {
  boolean,
  index,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { notificationSchema } from "./_schemas";
import { auditMixin, idMixin } from "./_mixins";

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
    title: text("title").notNull(),
    body: text("body"),
    deepLink: text("deep_link"),
    unread: boolean("unread").notNull().default(true),
    archived: boolean("archived").notNull().default(false),
    emailedAt: timestamp("emailed_at", { withTimezone: true, mode: "date" }),
  },
  (t) => ({
    userUnreadIdx: index("notifications_user_unread_idx").on(t.userId, t.unread),
    orgIdx: index("notifications_org_idx").on(t.orgId),
  }),
);
