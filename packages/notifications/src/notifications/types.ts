/** Valid kind values enforced by DB CHECK constraint. */
export const NOTIFICATION_KINDS = [
  "system",
  "approval",
  "run",
  "member",
  "security",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

/** Input to createNotification. All required except workspaceId. */
export interface CreateNotificationInput {
  orgId: string;
  workspaceId?: string;
  userId: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  deepLink?: string;
}

/** A persisted notification row (subset returned to callers). */
export interface NotificationRow {
  id: string;
  publicId: string;
  orgId: string;
  workspaceId: string | null;
  userId: string;
  kind: NotificationKind;
  title: string;
  body: string | null;
  deepLink: string | null;
  unread: boolean;
  archived: boolean;
  emailedAt: Date | null;
  createdAt: Date;
}
