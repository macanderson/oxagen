"use client";
// Notifications from the bell in the top bar. Every kind here maps to a frame
// kind or an audit event (the mockup's notifications dialog, as a popover).
import { Popover } from "@base-ui/react/popover";
import {
  Bell,
  CircleAlert,
  CircleCheck,
  Info,
  type LucideIcon,
  OctagonAlert,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import type { Read } from "@/data/not-backed";
import type {
  NotificationFeed,
  NotificationItem,
  NotificationSeverity,
} from "./contracts";
import {
  SEVERITY_TONE,
  formatTimestamp,
  sortNotifications,
  unreadCount,
} from "./format";
import { parseShellPath } from "./nav";

const SEVERITY_ICON: Record<NotificationSeverity, LucideIcon> = {
  success: CircleCheck,
  info: Info,
  attention: CircleAlert,
  critical: OctagonAlert,
};

function Item({
  item,
  runHref,
}: {
  item: NotificationItem;
  runHref: string | null;
}) {
  const t = useTranslations("shell.notifications");
  const locale = useLocale();
  const Icon = SEVERITY_ICON[item.severity];
  return (
    <li
      data-unread={item.unread}
      className={`flex gap-3 border-b border-border px-4 py-3 last:border-b-0 ${item.unread ? "bg-accent/40" : ""}`}
    >
      <Icon
        aria-hidden="true"
        className={`mt-0.5 size-4 flex-none ${SEVERITY_TONE[item.severity]}`}
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {item.unread ? (
            <span className="sr-only">{t("unreadMarker")}: </span>
          ) : null}
          {item.title}
        </p>
        <p className="mt-0.5 text-[13px] text-muted-foreground">{item.body}</p>
        <p className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <span>{item.kind}</span>
          {runHref === null || item.runId === null ? null : (
            <Link
              href={runHref}
              className="text-link underline-offset-2 hover:underline"
            >
              {t("openRun", { run: item.runId })}
            </Link>
          )}
        </p>
      </div>
      <time
        dateTime={item.at}
        className="flex-none font-mono text-[11px] text-muted-foreground"
      >
        {formatTimestamp(item.at, locale)}
      </time>
    </li>
  );
}

function Body({ read }: { read: Read<NotificationFeed> }) {
  const t = useTranslations("shell.notifications");
  const pathname = usePathname();
  const { org, ws } = parseShellPath(pathname);
  if (!read.ok) {
    const [title, body] =
      read.reason === "error"
        ? [
            t("error.title"),
            t("error.body", { code: read.code, status: read.status }),
          ]
        : read.reason === "denied"
          ? [
              t("denied.title"),
              t("denied.body", { permission: read.permission }),
            ]
          : [
              t("notBacked.title"),
              t("notBacked.body", { milestone: read.milestone, gap: read.gap }),
            ];
    return (
      <div data-testid={`notifications-${read.reason}`} className="px-4 py-6">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-[13px] text-muted-foreground">{body}</p>
      </div>
    );
  }
  if (read.value.items.length === 0)
    return (
      <div data-testid="notifications-empty" className="px-4 py-6">
        <p className="text-sm font-medium">{t("empty.title")}</p>
        <p className="mt-1 text-[13px] text-muted-foreground">
          {t("empty.body")}
        </p>
      </div>
    );
  return (
    <ul
      data-testid="notifications-list"
      className="max-h-[min(60dvh,480px)] overflow-y-auto"
    >
      {sortNotifications(read.value.items).map((item) => (
        <Item
          key={item.id}
          item={item}
          runHref={
            org !== null && ws !== null && item.runId !== null
              ? `/${encodeURIComponent(org)}/${encodeURIComponent(ws)}/runs/${encodeURIComponent(item.runId)}`
              : null
          }
        />
      ))}
    </ul>
  );
}

export function NotificationsPopover({
  read,
  className,
}: {
  read: Read<NotificationFeed>;
  className: string;
}) {
  const t = useTranslations("shell");
  const unread = read.ok ? unreadCount(read.value.items) : 0;
  return (
    <Popover.Root>
      <Popover.Trigger
        className={className}
        aria-label={t("topbar.notifications", { count: unread })}
        data-testid="notifications-trigger"
      >
        <Bell aria-hidden="true" className="size-4" />
        {unread > 0 ? (
          <span
            aria-hidden="true"
            className="absolute right-1 top-1 size-2 rounded-full bg-primary"
          />
        ) : null}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="end" className="z-50">
          <Popover.Popup
            data-testid="notifications-popover"
            className="w-[min(420px,calc(100vw-1.5rem))] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg outline-none"
          >
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <Popover.Title className="text-sm font-semibold">
                {t("notifications.title")}
              </Popover.Title>
              {read.ok ? (
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                  {t("notifications.unread", { count: unread })}
                </span>
              ) : null}
            </div>
            <Body read={read} />
            <p className="border-t border-border px-4 py-2.5 text-[11px] text-muted-foreground">
              {t("notifications.footer")}
            </p>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
