"use client";
// The sidebar (mockup `sidebar()`): brand, organization and workspace
// switchers, the Workspace and Organization sections, and the assistant
// launcher the flyout flies out of.
import { OxagenWordmark } from "@oxagen/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId } from "react";
import { AssistantLauncher } from "./assistant-launcher";
import {
  isNavItemCurrent,
  type NavSection,
  parseShellPath,
  sidebarSections,
  visibleCount,
} from "./nav";
import { NAV_ICONS } from "./nav-icons";
import { activeWorkspace, type ShellData } from "./shell-data";
import { OrgSwitcher, WorkspaceSwitcher } from "./switchers";

/** Sidebar sections for the current URL. Shared by the desktop rail, the phone drawer and <MobileNav>. */
export function useSidebarSections(data: ShellData): {
  sections: NavSection[];
  ws: string | null;
  pathname: string;
} {
  const pathname = usePathname();
  const urlWs = parseShellPath(pathname).ws;
  const ws = activeWorkspace(data, urlWs);
  const counts =
    data.counts.ok && ws !== null ? (data.counts.value[ws] ?? null) : null;
  return { sections: sidebarSections(data.org, ws, counts), ws, pathname };
}

export function SidebarNav({
  data,
  onNavigate,
}: {
  data: ShellData;
  onNavigate?: () => void;
}) {
  const t = useTranslations("shell");
  const { sections, pathname } = useSidebarSections(data);
  const labelId = useId();
  return (
    <nav aria-label={t("sidebar.navLabel")} className="flex-1 px-2.5 py-3">
      {sections.map((section) => (
        <div key={section.key} className="mb-3">
          <p
            id={`${labelId}-${section.key}`}
            className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-sidebar-nav-label-fg"
          >
            {t(`sidebar.sections.${section.key}`)}
          </p>
          <ul aria-labelledby={`${labelId}-${section.key}`}>
            {section.items.map((item) => {
              const Icon = NAV_ICONS[item.key];
              const current = isNavItemCurrent(item.key, pathname);
              const count = visibleCount(item);
              return (
                <li key={item.key}>
                  <Link
                    href={item.href}
                    aria-current={current ? "page" : undefined}
                    data-nav={item.key}
                    onClick={onNavigate}
                    className={`mb-px flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring ${
                      current
                        ? "bg-sidebar-nav-link-active-bg text-sidebar-nav-link-active-fg shadow-[inset_2px_0_0_var(--primary)]"
                        : "text-sidebar-nav-link-fg hover:bg-sidebar-nav-link-hover-bg hover:text-sidebar-nav-link-hover-fg"
                    }`}
                  >
                    <Icon
                      aria-hidden="true"
                      className="size-4 flex-none opacity-85"
                    />
                    <span className="flex-1">{t(`nav.${item.key}`)}</span>
                    {count === null ? null : (
                      <span
                        className={`rounded border px-1.5 font-mono text-[11px] ${
                          item.hot
                            ? "border-current text-link"
                            : "border-sidebar-border text-sidebar-nav-label-fg"
                        }`}
                      >
                        <span aria-hidden="true">{count}</span>
                        <span className="sr-only">
                          {item.hot
                            ? t("sidebar.attentionLabel", { count })
                            : t("sidebar.countLabel", { count })}
                        </span>
                      </span>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function SidebarHeader({ data }: { data: ShellData }) {
  const { ws } = useSidebarSections(data);
  const tApp = useTranslations("app");
  return (
    <div className="border-b border-sidebar-border px-3.5 pb-3 pt-4">
      <Link
        href={`/${encodeURIComponent(data.org)}`}
        className="mb-3 inline-flex rounded-sm px-1 focus-visible:outline-2 focus-visible:outline-ring"
        aria-label={tApp("name")}
      >
        <OxagenWordmark className="h-6" />
      </Link>
      {data.context.ok ? (
        <>
          <OrgSwitcher context={data.context.value} />
          <WorkspaceSwitcher
            context={data.context.value}
            current={ws}
            counts={data.counts.ok ? data.counts.value : null}
          />
        </>
      ) : (
        <p className="truncate px-1 font-mono text-xs text-sidebar-nav-label-fg">
          {data.org}
        </p>
      )}
    </div>
  );
}

export function SidebarFooter({ data }: { data: ShellData }) {
  const t = useTranslations("shell.sidebar");
  const { ws } = useSidebarSections(data);
  const context = data.context.ok ? data.context.value : null;
  const agents =
    ws !== null && data.counts.ok
      ? (data.counts.value[ws]?.agents ?? null)
      : null;
  return (
    <div className="border-t border-sidebar-border p-2.5">
      <AssistantLauncher engine={data.engine} />
      {context === null ? null : (
        <p className="px-1 font-mono text-[11px] text-sidebar-nav-label-fg">
          {agents === null
            ? t("footerPlaneOnly", { plane: context.org.dataPlane })
            : t("footer", { agents, plane: context.org.dataPlane })}
        </p>
      )}
    </div>
  );
}

/** The desktop rail. Hidden below `md`, where <MobileNav> and the drawer take over. */
export function Sidebar({ data }: { data: ShellData }) {
  const t = useTranslations("shell.sidebar");
  return (
    <aside
      aria-label={t("label")}
      className="sticky top-0 z-40 hidden h-dvh flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar-bg text-sidebar-fg md:col-start-1 md:row-span-2 md:row-start-1 md:flex"
    >
      <SidebarHeader data={data} />
      <SidebarNav data={data} />
      <SidebarFooter data={data} />
    </aside>
  );
}
