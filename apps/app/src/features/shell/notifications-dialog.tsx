"use client";
// The bell's dialog (mockup `DLG notifs`, `notifsBody()`): the viewer's newest
// notifications, each with its kind's glyph, an unread dot, the title, the
// body, the §7.7 event it came from and when. The footer names the read and
// the unread count ("not recorded" when the feed could not say, never 0), and
// marks every listed row read. The receipt says how many rows it marked, that
// each mark is recorded, and how many unread rows past the list it left alone.
// On a phone it rises as a bottom sheet like every dialog.
import {
  AlertTriangle,
  CheckCheck,
  Clock3,
  GitPullRequest,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import type { ShellNotification } from "@/data/contracts/shell";
import { buttonSecondary } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { useNavigate } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { SheetDialog } from "@/ui/sheet-dialog";
import { markNotificationsRead } from "./notification-actions";
import type { ShellData } from "./shell-data";
import { useShellState } from "./shell-state";
import { useSidebarSections } from "./sidebar-sections";
import { useShellCounts } from "./use-activity";

/** `notifIcon(tone)`: approval waiting, done, a change, or a warning. */
function Glyph({ n }: { n: ShellNotification }) {
  const tone =
    n.event === "approval.requested"
      ? { Icon: Clock3, cls: "border-info/40 bg-info/10 text-info" }
      : n.event === "approval.resolved"
        ? {
            Icon: CheckCheck,
            cls: "border-success/40 bg-success/10 text-success",
          }
        : n.kind === "member" || n.kind === "run"
          ? {
              Icon: GitPullRequest,
              cls: "border-gold/40 bg-gold/10 text-accent-text",
            }
          : {
              Icon: AlertTriangle,
              cls: "border-error/40 bg-error/10 text-error-ink",
            };
  const { Icon, cls } = tone;
  return (
    <span
      aria-hidden="true"
      className={`grid size-6 flex-none place-items-center rounded-md border ${cls}`}
    >
      <Icon className="size-3" />
    </span>
  );
}

export function NotificationsDialog({ data }: { data: ShellData }) {
  const t = useTranslations("shell.notifications");
  const format = useFormatter();
  const navigate = useNavigate();
  const { notificationsOpen, setNotificationsOpen } = useShellState();
  const { ws } = useSidebarSections(data);
  const { feed } = useShellCounts(data);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{
    marked: number;
    left: number;
  } | null>(null);
  const items = feed?.ok ? feed.value.items : [];
  const unread = feed?.ok ? feed.value.unread : null;
  const unreadIds = items.filter((n) => n.unread).map((n) => n.id);
  const time = (iso: string) =>
    format.dateTime(new Date(iso), {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });

  async function markAll() {
    if (ws === null || pending) return;
    setPending(true);
    setFailure(null);
    setReceipt(null);
    try {
      const result = await markNotificationsRead(data.org.slug, ws, unreadIds);
      if (result.ok) {
        const { marked } = result.value;
        setReceipt({
          marked,
          left: unread === null ? 0 : Math.max(0, unread - unreadIds.length),
        });
        navigate.refresh();
      } else
        setFailure(
          result.reason === "denied" ? t("markDenied") : t("markFailed"),
        );
    } catch {
      setFailure(t("markFailed"));
    } finally {
      setPending(false);
    }
  }

  return (
    <SheetDialog
      open={notificationsOpen}
      onOpenChange={setNotificationsOpen}
      title={t("title")}
      testId="notifications-dialog"
      footer={
        <>
          <p className="mr-auto min-w-0 flex-1 basis-60 text-left text-xs text-muted-foreground">
            {unread === null
              ? t.rich("footerUnknown", {
                  code: (chunks) => <span className="font-mono">{chunks}</span>,
                })
              : t.rich("footer", {
                  count: String(unread),
                  code: (chunks) => <span className="font-mono">{chunks}</span>,
                })}
          </p>
          {unreadIds.length > 0 && ws !== null ? (
            <button
              type="button"
              data-testid="mark-all-read"
              disabled={pending}
              onClick={() => void markAll()}
              className={buttonSecondary}
            >
              {t("markAll")}
            </button>
          ) : null}
        </>
      }
    >
      {feed === null ? (
        <p className="text-sm text-muted-foreground">{t("noWorkspace")}</p>
      ) : !feed.ok ? (
        <ReadFailure read={feed} section={t("title")} />
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="overflow-hidden rounded-lg border border-border">
          {items.map((n) => (
            <li
              key={n.id}
              data-testid="notification"
              data-unread={n.unread ? "" : undefined}
              className={`flex gap-3 border-b border-border px-3 py-2.5 last:border-b-0 ${
                n.unread ? "bg-hl" : "bg-card"
              }`}
            >
              <Glyph n={n} />
              <div className="min-w-0 flex-1">
                <p className="text-[13px] text-foreground">
                  {n.unread ? (
                    <span
                      aria-hidden="true"
                      className="mr-1.5 inline-block size-[5px] rounded-full bg-gold align-middle"
                    />
                  ) : null}
                  {n.unread ? (
                    <span className="sr-only">{t("unread")} </span>
                  ) : null}
                  {n.title}
                </p>
                {n.body === null ? null : (
                  <p className="text-xs text-muted-foreground">{n.body}</p>
                )}
                {n.event === null ? null : (
                  <p className="mt-0.5 font-mono text-[11px] text-dim">
                    {n.event}
                  </p>
                )}
              </div>
              <time
                dateTime={n.createdAt}
                className="flex-none font-mono text-[11px] text-dim"
              >
                {time(n.createdAt)}
              </time>
            </li>
          ))}
        </ul>
      )}
      {receipt === null ? null : (
        <p
          role="status"
          data-testid="mark-receipt"
          className="mt-2 text-xs text-muted-foreground"
        >
          {t("marked", { count: receipt.marked })}
          {receipt.left > 0
            ? ` ${t("markedLeft", { count: receipt.left })}`
            : null}
        </p>
      )}
      {failure === null ? null : (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {failure}
        </p>
      )}
    </SheetDialog>
  );
}
