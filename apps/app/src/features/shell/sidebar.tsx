"use client";
// The sidebar (mockup `sidebar()`): brand, the organization and workspace
// tiles, and the Workspace and Organization sections.
import { OxagenWordmark } from "@oxagen/ui";
import { usePathname } from "next/navigation";
import { useTranslations } from "next-intl";
import { AssistantLauncher } from "./assistant-launcher";
import { useId } from "react";
import {
  isNavItemCurrent,
  type NavSection,
  parseShellPath,
  sidebarSections,
} from "./nav";
import { NAV_ICONS } from "./nav-icons";
import type { ShellData } from "./shell-data";
import { OrgSwitcher, WorkspaceSwitcher } from "./switchers";
import { routes } from "@/shared/safe-path";
import { SafeLink } from "@/ui/navigation";

/**
 * Sidebar sections for the current URL. Shared by the desktop rail, the phone
 * drawer, <ShellMobileNav> and the command menu. The workspace is the one in
 * the URL or, on an organization page, the first `shell.context` lists, so the
 * workspace links always point somewhere the viewer can open.
 */
export function useSidebarSections(data: ShellData): {
  sections: NavSection[];
  ws: string | null;
  pathname: string;
} {
  const pathname = usePathname();
  const { context } = data;
  const ws =
    parseShellPath(pathname).ws ??
    (context.ok ? (context.value.workspaces[0]?.slug ?? null) : null);
  return { sections: sidebarSections(data.org.slug, ws), ws, pathname };
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
              return (
                <li key={item.key}>
                  <SafeLink
                    to={item.href}
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
                  </SafeLink>
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
      <SafeLink
        to={routes.people(data.org.slug)}
        className="mb-3 inline-flex rounded-sm px-1 focus-visible:outline-2 focus-visible:outline-ring"
        aria-label={tApp("name")}
      >
        <OxagenWordmark className="h-6" />
      </SafeLink>
      <OrgSwitcher data={data} />
      <WorkspaceSwitcher data={data} ws={ws} />
    </div>
  );
}

/** The desktop rail. Hidden below `md`, where the thumb bar and the drawer take over. */
export function Sidebar({ data }: { data: ShellData }) {
  const t = useTranslations("shell.sidebar");
  return (
    <aside
      aria-label={t("label")}
      className="sticky top-0 z-40 hidden h-dvh flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar-bg text-sidebar-fg md:col-start-1 md:row-span-2 md:row-start-1 md:flex"
    >
      <SidebarHeader data={data} />
      <SidebarNav data={data} />
      <div className="mt-auto px-2.5">
        <AssistantLauncher />
      </div>
    </aside>
  );
}
