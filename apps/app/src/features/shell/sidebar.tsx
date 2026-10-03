"use client";
// The sidebar (mockup `sidebar()`): brand, the organization and workspace
// tiles, the Workspace and Organization sections, and the foot: the assistant
// launcher and the connection badge.
import { OxagenWordmark } from "@oxagen/ui";
import { useTranslations } from "next-intl";
import { useId, useSyncExternalStore } from "react";
import { AssistantLauncher } from "./assistant-launcher";
import { isNavItemCurrent, type NavKey } from "./nav";
import { NAV_ICONS } from "./nav-icons";
import type { ShellData } from "./shell-data";
import { useSidebarSections } from "./sidebar-sections";
import { OrgSwitcher, WorkspaceSwitcher } from "./switchers";
import { type ShellCounts, useShellCounts } from "./use-activity";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import { SafeLink } from "@/ui/navigation";

export { useSidebarSections } from "./sidebar-sections";

/**
 * `.navitem .ct`: a count appears only where something waits on a person
 * (audit-prompt check 5): Fleet (parked approvals), Steering (proposals) and
 * Audit (open critical incidents). `hot` is `.ct.hot`, the approval ink.
 */
function navCount(
  key: NavKey,
  counts: ShellCounts,
): { value: number | null; hot: boolean; more: boolean } | null {
  if (key !== "fleet" && key !== "steering" && key !== "audit") return null;
  const hot = key !== "steering";
  // A read that landed without a figure says so; it never reads as zero.
  if (counts.unrecorded.includes(key)) return { value: null, hot, more: false };
  const value = counts[key];
  if (value === null || value <= 0) return null;
  // A queue that ran past the read says "+", as the drawer's header does.
  return { value, hot, more: key === "fleet" && counts.fleetMore };
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
  const counts = useShellCounts(data);
  const labelId = useId();
  return (
    <nav aria-label={t("sidebar.navLabel")} className="flex-1 px-2.5 py-3">
      {sections.map((section) => (
        <div key={section.key} className="mb-3">
          <p
            id={`${labelId}-${section.key}`}
            className="px-2 pb-1.5 pt-3 text-[10.5px] font-semibold uppercase tracking-[0.13em] text-sidebar-nav-label-fg"
          >
            {t(`sidebar.sections.${section.key}`)}
          </p>
          <ul aria-labelledby={`${labelId}-${section.key}`}>
            {section.items.map((item) => {
              const Icon = NAV_ICONS[item.key];
              const current = isNavItemCurrent(item.key, pathname);
              // Nothing waiting draws nothing; a count the read could not
              // give draws "?" and says it is not recorded.
              const waiting = navCount(item.key, counts);
              return (
                <li key={item.key}>
                  <SafeLink
                    to={item.href}
                    aria-current={current ? "page" : undefined}
                    data-nav={item.key}
                    onClick={onNavigate}
                    className={`mb-px flex items-center gap-2.5 rounded-lg px-[9px] py-[7px] text-[13.5px] font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring ${
                      current
                        ? "bg-sidebar-nav-link-active-bg text-sidebar-nav-link-active-fg shadow-[inset_2px_0_0_var(--gold)]"
                        : "text-sidebar-nav-link-fg hover:bg-sidebar-nav-link-hover-bg hover:text-sidebar-nav-link-hover-fg"
                    }`}
                  >
                    <Icon
                      aria-hidden="true"
                      className="size-4 flex-none opacity-85"
                    />
                    <span className="flex-1">{t(`nav.${item.key}`)}</span>
                    {waiting === null ? null : waiting.value === null ? (
                      <span
                        data-count={item.key}
                        data-count-unrecorded=""
                        title={t("sidebar.countNotRecorded")}
                        className="rounded-[5px] border border-dashed border-border bg-card px-[5px] font-mono text-[10.5px] text-sidebar-nav-label-fg"
                      >
                        <span aria-hidden="true">?</span>
                        <span className="sr-only">
                          {t("sidebar.countNotRecordedShort")}
                        </span>
                      </span>
                    ) : (
                      <span
                        data-count={item.key}
                        className={`rounded-[5px] border bg-card px-[5px] font-mono text-[10.5px] ${
                          waiting.hot
                            ? "border-info/40 text-info"
                            : "border-border text-sidebar-nav-label-fg"
                        }`}
                      >
                        <span aria-hidden="true">
                          {waiting.value}
                          {waiting.more ? "+" : ""}
                        </span>
                        <span className="sr-only">
                          {/* Audit counts open critical incidents, which
                              are open, not waiting (mobileNav.incidents). */}
                          {item.key === "audit"
                            ? t("sidebar.open", { count: waiting.value })
                            : t("sidebar.waiting", {
                                count: `${String(waiting.value)}${waiting.more ? "+" : ""}`,
                              })}
                        </span>
                      </span>
                    )}
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

function subscribeOnline(listener: () => void): () => void {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

/**
 * The connection badge. The chrome rendered from a control-plane read, so it
 * was reachable then; after that the badge follows the browser's own
 * connection, and says offline the moment it drops.
 */
function ConnectionBadge() {
  const t = useTranslations("shell.sidebar.foot");
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
  return (
    <span data-testid="connection" title={online ? t("reachable") : undefined}>
      <Badge tone={online ? "allowed" : "failed"}>
        {online ? t("connected") : t("offline")}
      </Badge>
    </span>
  );
}

/**
 * `.side-foot`: the assistant launcher, then the connection badge. The mockup
 * puts the organization's agent count and data plane beside the badge, but no
 * read an organization member can make answers them for the whole
 * organization (`list_agents` is per workspace, `get_data_plane` is Owner and
 * Admin), so the foot draws nothing there until that read exists (#3851).
 */
export function SidebarFoot({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <div className="mt-auto border-t border-sidebar-border px-2.5 pb-3 pt-2.5">
      <AssistantLauncher {...(onNavigate ? { onNavigate } : {})} />
      <div className="flex items-center justify-end gap-2 px-1">
        <ConnectionBadge />
      </div>
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
      <SidebarFoot />
    </aside>
  );
}
