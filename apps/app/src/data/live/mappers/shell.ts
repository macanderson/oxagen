// list_notifications output to the bell's feed (ARCHITECTURE.md §3.4). The
// mapper copies what the contract carries: the publicId as the row's id, the
// §7.7 event as its mono line, and the unread count the handler computed over
// the whole feed, which is what the dot and the dialog footer name.
import type { notificationsList } from "@oxagen/oxagen/contracts/notification.list";
import type { z } from "zod";
import type { NotificationFeed } from "@/data/contracts/shell";
import type { ContractOutput } from "@/server/kernel";

export function toNotificationFeed(
  out: ContractOutput<typeof notificationsList>,
): z.input<typeof NotificationFeed> {
  return {
    items: out.notifications
      .filter((n) => !n.archived)
      .map((n) => ({
        id: n.publicId,
        title: n.title,
        body: n.body,
        event: n.event,
        kind: n.kind,
        unread: n.unread,
        createdAt: n.createdAt,
      })),
    unread: out.unreadCount,
  };
}
