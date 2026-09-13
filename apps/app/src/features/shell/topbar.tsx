"use client";
// The top bar (mockup `topbar()`): phone menu, breadcrumbs, the ⌘K search
// button, notifications, the assistant toggle and the account menu.
import { Menu, Search, Sparkles } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Fragment } from "react";
import { ASSISTANT_PANEL_ID } from "./assistant-launcher";
import { breadcrumbs, parseShellPath } from "./nav";
import { NotificationsPopover } from "./notifications-popover";
import type { ShellData } from "./shell-data";
import { useShellState } from "./shell-state";
import { UserMenu } from "./user-menu";

const iconButton =
  "relative grid size-8 place-items-center rounded-md border border-app-topbar-border text-app-link-fg hover:text-app-link-hover-fg focus-visible:outline-2 focus-visible:outline-ring";

function Breadcrumbs({ data }: { data: ShellData }) {
  const t = useTranslations("shell");
  const pathname = usePathname();
  const context = data.context.ok ? data.context.value : null;
  const wsSlug = parseShellPath(pathname).ws;
  const wsName =
    context?.workspaces.find((w) => w.slug === wsSlug)?.name ?? null;
  const crumbs = breadcrumbs(pathname, {
    org: context?.org.name ?? data.org,
    ws: wsName,
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
                <li aria-hidden="true" className="text-muted-foreground">
                  /
                </li>
              ) : null}
              <li
                className={`truncate ${i < crumbs.length - 2 ? "hidden sm:block" : ""} ${mono ? "font-mono text-[13px]" : ""}`}
              >
                {crumb.href === null ? (
                  <span
                    aria-current="page"
                    className="font-semibold text-app-topbar-fg"
                  >
                    {label}
                  </span>
                ) : (
                  <Link
                    href={crumb.href}
                    className="text-app-link-fg hover:text-app-link-hover-fg"
                  >
                    {label}
                  </Link>
                )}
              </li>
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}

export function Topbar({ data }: { data: ShellData }) {
  const t = useTranslations("shell.topbar");
  const tShell = useTranslations("shell");
  const { setCommandOpen, setDrawerOpen, assistantOpen, toggleAssistant } =
    useShellState();
  return (
    <header
      aria-label={t("label")}
      className="sticky top-0 z-30 flex items-center gap-3 border-b border-app-topbar-border bg-app-topbar-bg/90 px-4 py-2.5 text-app-topbar-fg backdrop-blur md:col-start-2 md:row-start-1 md:px-5"
    >
      <a
        href="#main"
        className="sr-only rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50"
      >
        {tShell("skipToContent")}
      </a>
      <button
        type="button"
        className={`${iconButton} md:hidden`}
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
        className="flex items-center gap-2 rounded-md border border-app-topbar-border px-2.5 py-1.5 text-sm text-app-link-fg hover:text-app-link-hover-fg focus-visible:outline-2 focus-visible:outline-ring"
      >
        <Search aria-hidden="true" className="size-3.5" />
        <span className="hidden lg:inline">{t("search")}</span>
        <kbd
          aria-hidden="true"
          className="hidden rounded border border-app-topbar-border px-1 font-mono text-[11px] sm:inline"
        >
          {t("searchShortcut")}
        </kbd>
      </button>
      <NotificationsPopover read={data.notifications} className={iconButton} />
      <button
        type="button"
        className={iconButton}
        aria-label={t("assistant")}
        aria-controls={ASSISTANT_PANEL_ID}
        aria-expanded={assistantOpen}
        onClick={toggleAssistant}
      >
        <Sparkles aria-hidden="true" className="size-4" />
      </button>
      <UserMenu data={data} />
    </header>
  );
}
