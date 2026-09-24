"use client";
// The top bar (mockup `topbar()`): phone menu, breadcrumbs, the ⌘K search
// button, the bell, the approvals button left of the avatar, and the user
// menu. There is no assistant button here: the launcher lives at the foot of
// the sidebar.
import { Bell, Menu, Search, ShieldCheck } from "lucide-react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Fragment } from "react";
import { breadcrumbs, parseShellPath } from "./nav";
import { usePageRecord } from "./page-record";
import type { ShellData } from "./shell-data";
import { useShellState } from "./shell-state";
import { type OrgWaiting, useShellCounts } from "./use-activity";
import { UserMenu } from "./user-menu";
import { SafeLink } from "@/ui/navigation";

const iconBase =
  "relative grid size-8 place-items-center rounded-lg border bg-card transition-colors focus-visible:outline-2 focus-visible:outline-ring";
const iconButton = `${iconBase} border-border text-muted-foreground hover:border-rule hover:text-foreground`;
/** `.apd-btn[aria-pressed="true"]`: the open drawer's button takes the approval ink. */
const iconButtonPressed = `${iconBase} border-info text-info`;

function Breadcrumbs({ data }: { data: ShellData }) {
  const t = useTranslations("shell");
  const pathname = usePathname();
  const { ws, rest } = parseShellPath(pathname);
  const record = usePageRecord(rest[0] ?? null);
  const { context } = data;
  // A workspace `shell.context` does not list keeps its slug as the crumb.
  const wsName = context.ok
    ? (context.value.workspaces.find((w) => w.slug === ws)?.name ?? null)
    : null;
  const crumbs = breadcrumbs(pathname, {
    org: data.org.name,
    ws: wsName,
    record,
  });
  return (
    <nav aria-label={t("topbar.breadcrumbs")} className="min-w-0 flex-1">
      <ol className="flex min-w-0 items-center gap-1.5 text-sm">
        {crumbs.map((crumb, i) => {
          const label =
            crumb.kind === "nav" ? t(`nav.${crumb.key}`) : crumb.text;
          const mono = crumb.kind === "id";
          return (
            <Fragment key={`${String(i)}-${label}`}>
              {i > 0 ? (
                <li
                  aria-hidden="true"
                  className="hidden text-muted-foreground md:block"
                >
                  /
                </li>
              ) : null}
              <li
                className={`truncate ${i < crumbs.length - 1 ? "hidden md:block" : ""} ${mono ? "font-mono text-[13px]" : ""}`}
              >
                {crumb.href === null ? (
                  <span
                    aria-current="page"
                    className="font-semibold text-app-topbar-fg"
                  >
                    {label}
                  </span>
                ) : (
                  <SafeLink
                    to={crumb.href}
                    className="text-app-link-fg hover:text-app-link-hover-fg"
                  >
                    {label}
                  </SafeLink>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}

/** The badge text: the count, "99+" past two digits, and "+" when a read stopped short. */
function waitingText(waiting: OrgWaiting): string {
  const shown = waiting.count > 99 ? "99+" : String(waiting.count);
  return waiting.partial && waiting.count <= 99 ? `${shown}+` : shown;
}

export function Topbar({ data }: { data: ShellData }) {
  const t = useTranslations("shell.topbar");
  const tShell = useTranslations("shell");
  const {
    setCommandOpen,
    setDrawerOpen,
    approvalsOpen,
    setApprovalsOpen,
    setNotificationsOpen,
  } = useShellState();
  const { waiting, feed } = useShellCounts(data);
  const unread = feed?.ok ? feed.value.unread : null;
  return (
    <header
      aria-label={t("label")}
      // viewport-fit=cover (app/layout.tsx) draws the page under a notch, so
      // the sticky bar pads its top by the inset (mockup `#viewport.phone .top`).
      className="sticky top-0 z-30 flex items-center gap-3 border-b border-app-topbar-border bg-app-topbar-bg/90 px-4 pb-2.5 pt-[calc(0.625rem+env(safe-area-inset-top))] text-app-topbar-fg backdrop-blur md:col-start-2 md:row-start-1 md:px-5"
    >
      <a
        href="#main"
        className="sr-only rounded-md bg-foreground px-3 py-1.5 text-sm text-background focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50"
      >
        {tShell("skipToContent")}
      </a>
      <button
        type="button"
        className={`${iconButton} md:hidden`}
        data-touch-target=""
        aria-label={t("menu")}
        onClick={() => {
          setDrawerOpen(true);
        }}
      >
        <Menu aria-hidden="true" className="size-4" />
      </button>
      <Breadcrumbs data={data} />
      <button
        type="button"
        onClick={() => {
          setCommandOpen(true);
        }}
        aria-keyshortcuts="Meta+K Control+K"
        aria-label={t("search")}
        data-touch-target=""
        className="flex items-center gap-2 rounded-[9px] border border-border bg-card px-2.5 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:border-rule hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring lg:min-w-[190px]"
      >
        <Search aria-hidden="true" className="size-3.5" />
        <span className="hidden lg:inline">{t("search")}</span>
        <kbd
          aria-hidden="true"
          className="ml-auto hidden rounded border border-border bg-hl px-[5px] font-mono text-[10.5px] text-muted-foreground sm:inline"
        >
          {t("searchShortcut")}
        </kbd>
      </button>
      <button
        type="button"
        data-testid="notifications-button"
        data-touch-target=""
        aria-haspopup="dialog"
        aria-label={
          unread === null
            ? t("notifications")
            : t("notificationsUnread", { count: unread })
        }
        onClick={() => {
          setNotificationsOpen(true);
        }}
        className={iconButton}
      >
        <Bell aria-hidden="true" className="size-4" />
        {unread !== null && unread > 0 ? (
          <span
            aria-hidden="true"
            data-testid="unread-dot"
            className="absolute right-1.5 top-1.5 size-[7px] rounded-full border border-app-topbar-bg bg-info"
          />
        ) : null}
      </button>
      <button
        type="button"
        id="apdrawer-button"
        data-testid="approvals-button"
        data-touch-target=""
        aria-controls="apdrawer"
        aria-pressed={approvalsOpen}
        aria-label={
          waiting === null
            ? t("approvals")
            : t("approvalsWaiting", { count: waitingText(waiting) })
        }
        onClick={() => {
          setApprovalsOpen(!approvalsOpen);
        }}
        className={approvalsOpen ? iconButtonPressed : iconButton}
      >
        <ShieldCheck aria-hidden="true" className="size-4" />
        {waiting !== null && waiting.count > 0 ? (
          <span
            aria-hidden="true"
            data-testid="approvals-count"
            className="absolute -right-1.5 -top-1.5 min-w-[18px] rounded-full border border-app-topbar-bg bg-info px-1 text-center font-mono text-[10px] font-semibold leading-4 text-info-foreground"
          >
            {waitingText(waiting)}
          </span>
        ) : null}
      </button>
      <UserMenu data={data} />
    </header>
  );
}
