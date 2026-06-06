import { schema, withSystemDb } from "@oxagen/database";
import { NOTIFICATION_KINDS } from "./types";
import type { CreateNotificationInput, NotificationRow } from "./types";

/**
 * Insert one notification row into notification.notifications.
 * Uses withSystemDb — the notification schema is not tenant-scoped.
 * Throws on invalid kind (belt-and-suspenders for runtime callers bypassing TS).
 */
export async function createNotification(
  input: CreateNotificationInput,
): Promise<Pick<NotificationRow, "id" | "publicId" | "createdAt">> {
  const { orgId, workspaceId, userId, kind, title, body, deepLink } = input;

  if (!(NOTIFICATION_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Invalid notification kind: ${kind}`);
  }

  return withSystemDb(async (tx) => {
    const rows = await tx
      .insert(schema.notifications)
      .values({
        orgId,
        workspaceId: workspaceId ?? null,
        userId,
        kind,
        title,
        body: body ?? null,
        deepLink: deepLink ?? null,
      })
      .returning({
        id: schema.notifications.id,
        publicId: schema.notifications.publicId,
        createdAt: schema.notifications.createdAt,
      });

    const row = rows[0];
    if (!row) {
      throw new Error("[createNotification] Insert returned no rows");
    }
    return row;
  });
}
