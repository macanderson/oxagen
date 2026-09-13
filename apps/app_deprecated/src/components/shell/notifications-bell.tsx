"use client";
/**
 * NotificationsBell — real data, wired to notifications.list + notifications.mark.
 * Renders an unread badge on the bell icon; sheet drawer shows the feed.
 * Mark-read on item click; archive via swipe-right chevron button.
 */

import * as React from "react";
import { Bell } from "lucide-react";
import {
  Sheet,
  SheetPopup,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { safeHref } from "@/lib/safe-url";
import { Tooltip, TooltipTrigger, TooltipPopup } from "@/components/ui/tooltip";
import {
  listNotificationsAction,
  markNotificationAction,
} from "./notifications";
import { useParams } from "next/navigation";

interface Notification {
  id: string;
  publicId: string;
  kind: string;
  title: string;
  body: string | null;
  deepLink: string | null;
  unread: boolean;
  archived: boolean;
  createdAt: string;
}

export function NotificationsBell() {
  const [open, setOpen] = React.useState(false);
  const [notifications, setNotifications] = React.useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = React.useState(0);
  const [loading, setLoading] = React.useState(false);
  const params = useParams<{ orgSlug: string; workspaceSlug: string }>();
  const orgSlug = params.orgSlug ?? "";
  const workspaceSlug = params.workspaceSlug ?? "";

  const load = React.useCallback(async () => {
    if (!orgSlug || !workspaceSlug) return;
    setLoading(true);
    try {
      const result = await listNotificationsAction(orgSlug, workspaceSlug);
      setNotifications(result.notifications);
      setUnreadCount(result.unreadCount);
    } catch {
      // Silently fail — bell is non-critical; app still works.
    } finally {
      setLoading(false);
    }
  }, [orgSlug, workspaceSlug]);

  // Load once on mount (for the badge count) and again each time the sheet
  // opens. There is no background polling — the badge only refreshes on mount,
  // on open, or after a failed mutation reverts. The load is deferred a tick so
  // the setState calls inside it don't run synchronously within the effect
  // (react-hooks/set-state-in-effect).
  React.useEffect(() => {
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [load]);

  React.useEffect(() => {
    if (!open) return;
    const t = setTimeout(() => void load(), 0);
    return () => clearTimeout(t);
  }, [open, load]);

  const handleMarkRead = async (notification: Notification) => {
    if (!notification.unread) return;
    // Optimistic update.
    setNotifications((prev) =>
      prev.map((n) =>
        n.publicId === notification.publicId ? { ...n, unread: false } : n,
      ),
    );
    setUnreadCount((c) => Math.max(0, c - 1));
    try {
      await markNotificationAction(
        orgSlug,
        workspaceSlug,
        notification.publicId,
        { read: true },
      );
    } catch {
      // Revert on failure.
      void load();
    }
  };

  const handleArchive = async (notification: Notification) => {
    setNotifications((prev) =>
      prev.filter((n) => n.publicId !== notification.publicId),
    );
    if (notification.unread) setUnreadCount((c) => Math.max(0, c - 1));
    try {
      await markNotificationAction(
        orgSlug,
        workspaceSlug,
        notification.publicId,
        { archived: true },
      );
    } catch {
      void load();
    }
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={
                unreadCount > 0
                  ? `Open notifications (${unreadCount} unread)`
                  : "Open notifications"
              }
              aria-haspopup="dialog"
              onClick={() => setOpen(true)}
              className={cn(
                "relative flex h-9 w-9 items-center justify-center rounded-md max-md:h-11 max-md:w-11",
                "text-app-link-fg transition-colors",
                "hover:bg-accent hover:text-app-link-hover-fg",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              )}
            />
          }
        >
          <Bell className="h-4 w-4" aria-hidden="true" />
          {unreadCount > 0 && (
            <span
              aria-hidden="true"
              className={cn(
                "absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center",
                "rounded-full bg-primary text-[10px] font-semibold text-primary-foreground",
              )}
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </TooltipTrigger>
        <TooltipPopup>Notifications</TooltipPopup>
      </Tooltip>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetPopup side="right" className="flex w-80 flex-col p-0 sm:w-80">
          <SheetHeader className="border-b border-border/40 px-4 py-3">
            <SheetTitle className="text-sm font-medium">
              Notifications
              {unreadCount > 0 && (
                <span className="ml-2 inline-flex items-center rounded-full bg-primary/10 px-1.5 py-0.5 text-[11px] font-semibold text-primary">
                  {unreadCount}
                </span>
              )}
            </SheetTitle>
          </SheetHeader>

          <div className="flex-1 overflow-y-auto">
            {loading && notifications.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <span className="text-xs text-muted-foreground">Loading…</span>
              </div>
            ) : notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
                <Bell
                  className="h-8 w-8 text-muted-foreground/30"
                  aria-hidden="true"
                />
                <p className="text-sm text-muted-foreground">
                  No notifications yet
                </p>
                <p className="text-xs text-muted-foreground/60">
                  Agent completions, approvals, and alerts will appear here.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-border/40">
                {notifications.map((n) => (
                  <li
                    key={n.publicId}
                    className={cn(
                      "group flex items-start gap-3 px-4 py-3 text-left transition-colors",
                      "hover:bg-accent/50",
                      n.unread && "bg-primary/5",
                    )}
                  >
                    <button
                      type="button"
                      className="flex-1 text-left"
                      onClick={() => {
                        void handleMarkRead(n);
                        // deepLink is server-supplied (and may originate from an
                        // automated notification producer): validate the scheme
                        // before navigating so a `javascript:` value can't fire.
                        const target = safeHref(n.deepLink);
                        if (target) window.location.href = target;
                      }}
                    >
                      <p
                        className={cn(
                          "text-xs leading-snug",
                          n.unread
                            ? "font-medium text-foreground"
                            : "text-muted-foreground",
                        )}
                      >
                        {n.title}
                      </p>
                      {n.body && (
                        <p className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground/80">
                          {n.body}
                        </p>
                      )}
                      <p className="mt-1 text-[10px] text-muted-foreground/50">
                        {new Date(n.createdAt).toLocaleDateString()}
                      </p>
                    </button>
                    <button
                      type="button"
                      aria-label="Archive notification"
                      onClick={() => void handleArchive(n)}
                      className={cn(
                        "mt-0.5 shrink-0 rounded p-0.5 opacity-0 transition-opacity",
                        "text-muted-foreground hover:text-foreground",
                        "group-hover:opacity-100 focus-visible:opacity-100",
                        "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                      )}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden="true"
                      >
                        <polyline points="9 10 4 15 9 20" />
                        <path d="M20 4v7a4 4 0 0 1-4 4H4" />
                      </svg>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SheetPopup>
      </Sheet>
    </>
  );
}
