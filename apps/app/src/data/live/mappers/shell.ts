// list_notifications output to the bell's feed (ARCHITECTURE.md §3.4). The
// mapper copies what the contract carries: the publicId as the row's id, the
// §7.7 event as its mono line, and the unread count the handler computed over
// the whole feed, which is what the dot and the dialog footer name.
//
// get_assistant_engine output to the flyout's engine line: the state and the
// last failed probe's code, and nothing about where the engine runs.
import type { assistantEngineGet } from "@oxagen/oxagen/contracts/assistant.engine.get";
import type { notificationsList } from "@oxagen/oxagen/contracts/notification.list";
import type { z } from "zod";
import type { AssistantEngine, NotificationFeed } from "@/data/contracts/shell";
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

/**
 * The probe's answer, less `endpoint`, `attempts`, `checkedAt` and
 * `incident`. The endpoint is an internal host and port the browser has no
 * use for. The flyout times its own cache from when the answer lands, because
 * the server's clock and the browser's need not agree.
 */
export function toAssistantEngine(
  out: ContractOutput<typeof assistantEngineGet>,
): z.input<typeof AssistantEngine> {
  return { state: out.state, error: out.error };
}
