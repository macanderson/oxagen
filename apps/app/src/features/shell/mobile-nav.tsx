"use client";
// The phone shell's navigation (ARCHITECTURE.md §1.2; mockup `mobileNav` and
// its More sheet): a fixed five-slot thumb bar — Fleet, Agents, Tools, Spend,
// More — with a count only where something waits on a person, the More sheet
// carrying the rest of the sidebar, and the drawer the top bar's menu button
// opens over a scrim. The Agents, Tools and Spend slots point at NotRecorded
// pages for the whole of rev1 and are kept deliberately: the bar is the phone's
// only navigation, and a four-slot bar would change again at every lane.
import { OrgSwitcher, WorkspaceSwitcher } from "./switchers";
import { useShellActivity } from "./activity";
import { Dialog } from "@base-ui/react/dialog";
import { Ellipsis, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
  isMoreCurrent,
  isNavItemCurrent,
  MORE_SHEET,
  type NavItem,
  THUMB_SLOTS,
} from "./nav";
import { NAV_ICONS } from "./nav-icons";
import type { ShellData } from "./shell-data";
import { useShellState } from "./shell-state";
import { AssistantLauncher } from "./assistant-launcher";
import { SidebarHeader, SidebarNav, useSidebarSections } from "./sidebar";
import { SafeLink } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";

const slotClass =
  "relative flex min-h-13 flex-col items-center justify-center gap-1 rounded-lg px-1 text-[10.5px] font-semibold focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring aria-[current=page]:text-app-topbar-fg";

/** The thumb bar and its More sheet, over the sidebar's items for the current URL. */
export function ShellMobileNav({ data }: { data: ShellData }) {
  const t = useTranslations("shell");
  const { sections, pathname, ws } = useSidebarSections(data);
  const { setCommandOpen, setNotificationsOpen, openAccount } = useShellState();
  const activity = useShellActivity();
  const currentCounts = activity?.read?.ok
    ? activity.read.value.workspaces.find((w) => w.slug === ws)?.counts
    : null;
  const [moreOpen, setMoreOpen] = useState(false);
  const items = new Map<string, NavItem>(
    sections.flatMap((s) => s.items).map((item) => [item.key, item]),
  );
  // Without a workspace the workspace slots have nowhere to point.
  const slots = THUMB_SLOTS.flatMap((key) => {
    const item = items.get(key);
    return item === undefined ? [] : [{ key, href: item.href }];
  });
  const more = MORE_SHEET.flatMap((key) => {
    const item = items.get(key);
    return item === undefined ? [] : [item];
  });
  const close = () => {
    setMoreOpen(false);
  };
  return (
    <>
      <nav
        aria-label={t("mobileNav.label")}
        data-testid="mobile-nav"
        data-thumb-bar=""
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 gap-0.5 border-t border-app-topbar-border bg-app-topbar-bg px-1 pt-1.5 text-app-link-fg md:hidden"
      >
        {slots.map(({ key, href }) => {
          const Icon = NAV_ICONS[key];
          const current = isNavItemCurrent(key, pathname);
          const waiting =
            key === "fleet"
              ? currentCounts?.ok
                ? currentCounts.value.approvals
                : data.fleetWaiting
              : null;
          return (
            <SafeLink
              key={key}
              to={href}
              data-slot={key}
              data-touch-target=""
              aria-current={current ? "page" : undefined}
              className={slotClass}
            >
              <Icon aria-hidden="true" className="size-5" />
              <span>{t(`mobileNav.slots.${key}`)}</span>
              {waiting !== null && waiting > 0 ? (
                <span
                  data-count={waiting}
                  className="absolute left-[calc(50%+6px)] top-0.5 min-w-[18px] rounded-full border border-border bg-app-panel-bg px-1 text-center font-mono text-[10px] text-foreground"
                >
                  <span aria-hidden="true">{waiting}</span>
                  <span className="sr-only">
                    {/* The name reads "Fleet, 3 approvals waiting". */}
                    {t("mobileNav.waiting", { count: waiting })}
                  </span>
                </span>
              ) : null}
            </SafeLink>
          );
        })}
        <button
          type="button"
          data-slot="more"
          data-touch-target=""
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          aria-current={isMoreCurrent(pathname) ? "page" : undefined}
          onClick={() => {
            setMoreOpen(true);
          }}
          className={`${slotClass} col-start-5`}
        >
          <Ellipsis aria-hidden="true" className="size-5" />
          <span>{t("mobileNav.more")}</span>
        </button>
      </nav>
      <SheetDialog
        open={moreOpen}
        onOpenChange={setMoreOpen}
        title={t("mobileNav.more")}
        testId="more-sheet"
      >
        <ul className="grid grid-cols-2 gap-2">
          {more.map((item) => {
            const Icon = NAV_ICONS[item.key];
            return (
              <li key={item.key}>
                <SafeLink
                  to={item.href}
                  data-touch-target=""
                  aria-current={
                    isNavItemCurrent(item.key, pathname) ? "page" : undefined
                  }
                  onClick={close}
                  className="flex min-h-14 items-center gap-2.5 rounded-xl border border-border bg-card px-2.5 py-2 text-sm font-semibold text-card-foreground focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span className="grid size-7 flex-none place-items-center rounded-lg border border-border bg-muted text-muted-foreground">
                    <Icon aria-hidden="true" className="size-4" />
                  </span>
                  {t(`nav.${item.key}`)}
                </SafeLink>
              </li>
            );
          })}
        </ul>
        <div className="mt-4 flex flex-col gap-2">
          <button
            type="button"
            className="min-h-11 rounded-lg border border-border p-3 text-left"
            onClick={() => {
              close();
              setCommandOpen(true);
            }}
          >
            {t("topbar.search")}
          </button>
          <button
            type="button"
            className="min-h-11 rounded-lg border border-border p-3 text-left"
            onClick={() => {
              close();
              setNotificationsOpen(true);
            }}
          >
            {t("activity.notifications")}
          </button>
          <button
            type="button"
            className="min-h-11 rounded-lg border border-border p-3 text-left"
            onClick={() => {
              close();
              openAccount("profile");
            }}
          >
            {t("account.title")}
          </button>
          <OrgSwitcher data={data} />
          <WorkspaceSwitcher data={data} ws={ws} />
        </div>
      </SheetDialog>
    </>
  );
}

/**
 * The phone drawer: the whole sidebar over a scrim, opened from the top bar's
 * menu button — the rail's foot included, so the assistant launcher a phone
 * cannot reach in the `hidden md:flex` rail is reachable here (ADR-026).
 */
export function NavDrawer({ data }: { data: ShellData }) {
  const t = useTranslations("shell.drawer");
  const { drawerOpen, setDrawerOpen } = useShellState();
  const close = () => {
    setDrawerOpen(false);
  };
  return (
    <Dialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop
          data-scrim=""
          className="fixed inset-0 z-50 bg-overlay-scrim md:hidden"
        />
        <Dialog.Popup
          data-testid="nav-drawer"
          className="fixed inset-y-0 left-0 z-50 flex w-[min(18.75rem,86vw)] flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar-bg pb-[env(safe-area-inset-bottom)] text-sidebar-fg shadow-2xl md:hidden"
        >
          <div className="flex items-center px-3 pt-3">
            <Dialog.Title className="sr-only">{t("title")}</Dialog.Title>
            <Dialog.Close
              aria-label={t("close")}
              data-touch-target=""
              className="ml-auto grid place-items-center rounded-sm p-1 text-sidebar-nav-label-fg hover:text-sidebar-fg focus-visible:outline-2 focus-visible:outline-ring"
            >
              <X aria-hidden="true" className="size-4" />
            </Dialog.Close>
          </div>
          <SidebarHeader data={data} />
          <SidebarNav data={data} onNavigate={close} />
          <div className="mt-auto px-2.5">
            <AssistantLauncher onNavigate={close} />
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
