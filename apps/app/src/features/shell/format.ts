// Formatting helpers for the shell. Timestamps render in UTC with explicit
// options, so the server render and the client hydrate to the same text
// (spec §15: dates format by locale; the wedge is English and UTC).
import type {
  Notification,
  NotificationSeverity,
} from "@/data/contracts/shell";

export function formatTimestamp(iso: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
  }).format(new Date(iso));
}

export function unreadCount(
  items: readonly Pick<Notification, "unread">[],
): number {
  return items.reduce((n, item) => n + (item.unread ? 1 : 0), 0);
}

/** Newest first; unread before read at the same instant. */
export function sortNotifications<
  T extends Pick<Notification, "at" | "unread">,
>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const byTime = Date.parse(b.at) - Date.parse(a.at);
    if (byTime !== 0) return byTime;
    return Number(b.unread) - Number(a.unread);
  });
}

/** The house status token each severity draws in. */
export const SEVERITY_TONE: Record<NotificationSeverity, string> = {
  success: "text-success",
  info: "text-info",
  attention: "text-warning",
  critical: "text-error",
};

/** Two-letter initials for an avatar: first and last word, uppercased. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? (words.at(-1)?.[0] ?? "") : "";
  return `${first}${last}`.toLocaleUpperCase();
}
