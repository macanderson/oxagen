"use client";
// The top bar (mockup `topbar()`): phone menu, breadcrumbs, the ⌘K search
// button and the user menu.
import { Menu, Search } from "lucide-react";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { Fragment } from "react";
import { breadcrumbs, parseShellPath } from "./nav";
import type { ShellData } from "./shell-data";
import { useShellState } from "./shell-state";
import { UserMenu } from "./user-menu";
import { SafeLink } from "@/ui/navigation";

const iconButton =
  "relative grid size-8 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:border-rule hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";

function Breadcrumbs({ data }: { data: ShellData }) {
  const t = useTranslations("shell");
  const pathname = usePathname();
  const { ws } = parseShellPath(pathname);
  const { context } = data;
  // A workspace `shell.context` does not list keeps its slug as the crumb.
  const wsName = context.ok
    ? (context.value.workspaces.find((w) => w.slug === ws)?.name ?? null)
    : null;
  const crumbs = breadcrumbs(pathname, { org: data.org.name, ws: wsName });
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

export function Topbar({ data }: { data: ShellData }) {
  const t = useTranslations("shell.topbar");
  const tShell = useTranslations("shell");
  const { setCommandOpen, setDrawerOpen } = useShellState();
  return (
    <header
      aria-label={t("label")}
      className="sticky top-0 z-30 flex items-center gap-3 border-b border-app-topbar-border bg-app-topbar-bg/90 px-4 py-2.5 text-app-topbar-fg backdrop-blur md:col-start-2 md:row-start-1 md:px-5"
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
        className="flex items-center gap-2 rounded-[9px] border border-border bg-card px-2.5 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:border-rule hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring lg:min-w-[190px]"
      >
        <Search aria-hidden="true" className="size-3.5" />
        <span className="hidden lg:inline">{t("search")}</span>
        <kbd
          aria-hidden="true"
          className="ml-auto hidden rounded border border-border bg-hl px-[5px] font-mono text-[10.5px] text-dim sm:inline"
        >
          {t("searchShortcut")}
        </kbd>
      </button>
      <UserMenu data={data} />
    </header>
  );
}
