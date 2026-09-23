"use client";
// The phone shell's navigation (ARCHITECTURE.md §1.2; mockup `mobileNav` and
// `DLG_EXT.more`): a fixed five-slot thumb bar (Fleet, Agents, Tools, Spend,
// More) with a count only where something waits on a person, the More sheet
// carrying the rest of the sidebar, the assistant, search, notifications, the
// account and the two switchers, and the drawer the top bar's menu button
// opens over a scrim.
import { Dialog } from "@base-ui/react/dialog";
import {
  ArrowLeftRight,
  Bell,
  Building,
  Ellipsis,
  type LucideIcon,
  Search,
  Sparkles,
  UserRound,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useState } from "react";
import {
  isMoreCurrent,
  isNavItemCurrent,
  MORE_SHEET,
  type NavItem,
  type NavKey,
  THUMB_SLOTS,
} from "./nav";
import { NAV_ICONS } from "./nav-icons";
import type { ShellData } from "./shell-data";
import { useShellState } from "./shell-state";
import { SidebarFoot, SidebarHeader, SidebarNav } from "./sidebar";
import { useSidebarSections } from "./sidebar-sections";
import { orgChoices, SwitcherDialog, workspaceChoices } from "./switchers";
import { type ShellCounts, useShellCounts } from "./use-activity";
import { routes } from "@/shared/safe-path";
import { SafeLink } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";

const slotClass =
  "relative flex min-h-13 flex-col items-center justify-center gap-1 rounded-lg px-1 text-[10.5px] font-semibold focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring aria-[current=page]:text-app-topbar-fg";

/**
 * `.mn .ct.hot`: the slot's count, in the approval ink. A null count is a
 * read that landed without a figure: it draws "?" in a dashed pill and says
 * the count is not recorded, the way the sidebar does, never a zero.
 */
function SlotCount({ count, label }: { count: number | null; label: string }) {
  return count === null ? (
    <span
      data-count-unrecorded=""
      className="absolute left-[calc(50%+6px)] top-0.5 min-w-[18px] rounded-full border border-dashed border-border bg-app-panel-bg px-1 text-center font-mono text-[10px] text-muted-foreground"
    >
      <span aria-hidden="true">?</span>
      <span className="sr-only">{label}</span>
    </span>
  ) : (
    <span
      data-count={count}
      className="absolute left-[calc(50%+6px)] top-0.5 min-w-[18px] rounded-full border border-info/40 bg-app-panel-bg px-1 text-center font-mono text-[10px] text-info"
    >
      <span aria-hidden="true">{count}</span>
      <span className="sr-only">{label}</span>
    </span>
  );
}

/** `.mn[aria-current=page]::before`: the 26 by 2 px gold bar above the current slot. */
function CurrentMarker() {
  return (
    <span
      aria-hidden="true"
      data-current-marker=""
      className="absolute -top-1.5 left-1/2 h-0.5 w-[26px] -translate-x-1/2 rounded-b-[2px] bg-gold"
    />
  );
}

/** The keys the More sheet carries, each with its own line under the name. */
type MoreKey =
  | "steering"
  | "runtimes"
  | "repositories"
  | "organization"
  | "billing"
  | "audit";

function isMoreKey(key: NavKey): key is MoreKey {
  return (
    key === "steering" ||
    key === "runtimes" ||
    key === "repositories" ||
    key === "organization" ||
    key === "billing" ||
    key === "audit"
  );
}

/** What waits in a More tile's page: Steering's proposals and Audit's critical incidents. */
function tileCount(key: NavKey, counts: ShellCounts): number | null {
  const value =
    key === "steering"
      ? counts.steering
      : key === "audit"
        ? counts.audit
        : null;
  return value !== null && value > 0 ? value : null;
}

/** `.mtile`: an icon, a name, one line under it, and a count where something waits. */
function Tile({
  icon: Icon,
  label,
  sub,
  count = null,
  countLabel = "",
}: {
  icon: LucideIcon;
  label: string;
  sub: string;
  count?: number | null;
  countLabel?: string;
}) {
  return (
    <>
      <span className="grid size-7 flex-none place-items-center rounded-lg border border-border bg-muted text-muted-foreground">
        <Icon aria-hidden="true" className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <b className="block truncate text-sm font-semibold">{label}</b>
        <span className="block truncate text-xs font-normal text-muted-foreground">
          {sub}
        </span>
      </span>
      {count === null ? null : (
        <span className="flex-none rounded-[5px] border border-info/40 px-[5px] font-mono text-[10.5px] text-info">
          <span aria-hidden="true">{count}</span>
          <span className="sr-only">{countLabel}</span>
        </span>
      )}
    </>
  );
}

const tileClass =
  "flex min-h-14 w-full items-center gap-2.5 rounded-xl border border-border bg-card px-2.5 py-2 text-left text-card-foreground focus-visible:outline-2 focus-visible:outline-ring";

function TileButton({
  onClick,
  testId,
  children,
}: {
  onClick: () => void;
  testId: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-touch-target=""
      data-testid={testId}
      onClick={onClick}
      className={tileClass}
    >
      {children}
    </button>
  );
}

/** The thumb bar and its More sheet, over the sidebar's items for the current URL. */
export function ShellMobileNav({ data }: { data: ShellData }) {
  const t = useTranslations("shell");
  const { sections, pathname, ws } = useSidebarSections(data);
  const counts = useShellCounts(data);
  const {
    setCommandOpen,
    setNotificationsOpen,
    setAssistantOpen,
    openAccount,
  } = useShellState();
  const [moreOpen, setMoreOpen] = useState(false);
  const [switcher, setSwitcher] = useState<"org" | "ws" | null>(null);
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
    return item === undefined || !isMoreKey(item.key)
      ? []
      : [{ key: item.key, href: item.href }];
  });
  const close = () => {
    setMoreOpen(false);
  };
  /** Close the sheet, then open what the tile names, so two sheets never stack. */
  const then = (open: () => void) => () => {
    close();
    open();
  };
  const unread = counts.feed?.ok ? counts.feed.value.unread : null;
  const wsName =
    ws === null
      ? null
      : data.context.ok
        ? (data.context.value.workspaces.find((w) => w.slug === ws)?.name ?? ws)
        : ws;
  const moreWaiting =
    counts.audit !== null && counts.audit > 0 ? counts.audit : null;
  const moreCurrent = isMoreCurrent(pathname);
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
          const waiting = key === "fleet" ? counts.fleet : null;
          const fleetUnrecorded =
            key === "fleet" && counts.unrecorded.includes("fleet");
          return (
            <SafeLink
              key={key}
              to={href}
              data-slot={key}
              data-touch-target=""
              aria-current={current ? "page" : undefined}
              className={slotClass}
            >
              {current ? <CurrentMarker /> : null}
              <Icon aria-hidden="true" className="size-5" />
              <span>{t(`mobileNav.slots.${key}`)}</span>
              {fleetUnrecorded ? (
                <SlotCount
                  count={null}
                  label={t("sidebar.countNotRecordedShort")}
                />
              ) : waiting !== null && waiting > 0 ? (
                // The name reads "Fleet, 3 approvals waiting".
                <SlotCount
                  count={waiting}
                  label={t("mobileNav.waiting", { count: waiting })}
                />
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
          // The sheet being open is `aria-expanded`; `aria-current` names the
          // page the URL is on, and nothing else.
          aria-current={moreCurrent ? "page" : undefined}
          onClick={() => {
            setMoreOpen(true);
          }}
          className={`${slotClass} col-start-5`}
        >
          {moreCurrent ? <CurrentMarker /> : null}
          <Ellipsis aria-hidden="true" className="size-5" />
          <span>{t("mobileNav.more")}</span>
          {counts.unrecorded.includes("audit") ? (
            <SlotCount
              count={null}
              label={t("sidebar.countNotRecordedShort")}
            />
          ) : moreWaiting === null ? null : (
            <SlotCount
              count={moreWaiting}
              label={t("mobileNav.incidents", { count: moreWaiting })}
            />
          )}
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
            const count = tileCount(item.key, counts);
            return (
              <li key={item.key}>
                <SafeLink
                  to={item.href}
                  data-touch-target=""
                  aria-current={
                    isNavItemCurrent(item.key, pathname) ? "page" : undefined
                  }
                  onClick={close}
                  className={tileClass}
                >
                  <Tile
                    icon={NAV_ICONS[item.key]}
                    label={t(`nav.${item.key}`)}
                    sub={t(`mobileNav.sub.${item.key}`)}
                    count={count}
                    countLabel={
                      count === null
                        ? ""
                        : t("mobileNav.tileWaiting", { count })
                    }
                  />
                </SafeLink>
              </li>
            );
          })}
        </ul>
        <hr className="my-3 border-border" />
        <ul className="grid grid-cols-2 gap-2">
          <li>
            <TileButton
              testId="more-assistant"
              onClick={then(() => {
                setAssistantOpen(true);
              })}
            >
              <Tile
                icon={Sparkles}
                label={t("mobileNav.assistant")}
                sub={t("mobileNav.assistantSub")}
              />
            </TileButton>
          </li>
          <li>
            <TileButton
              testId="more-search"
              onClick={then(() => {
                setCommandOpen(true);
              })}
            >
              <Tile
                icon={Search}
                label={t("mobileNav.search")}
                sub={t("mobileNav.searchSub")}
              />
            </TileButton>
          </li>
          <li>
            <TileButton
              testId="more-notifications"
              onClick={then(() => {
                setNotificationsOpen(true);
              })}
            >
              <Tile
                icon={Bell}
                label={t("mobileNav.notifications")}
                sub={
                  unread === null
                    ? t("mobileNav.notificationsSub")
                    : t("topbar.unread", { count: unread })
                }
                count={unread !== null && unread > 0 ? unread : null}
                countLabel={
                  unread === null ? "" : t("topbar.unread", { count: unread })
                }
              />
            </TileButton>
          </li>
          <li>
            <TileButton
              testId="more-account"
              onClick={then(() => {
                openAccount("profile");
              })}
            >
              <Tile
                icon={UserRound}
                label={t("mobileNav.account")}
                sub={data.viewer.name ?? data.viewer.email}
              />
            </TileButton>
          </li>
        </ul>
        <hr className="my-3 border-border" />
        <ul className="grid grid-cols-1 gap-2">
          <li>
            <TileButton
              testId="more-switch-org"
              onClick={then(() => {
                setSwitcher("org");
              })}
            >
              <Tile
                icon={Building}
                label={t("switcher.org")}
                sub={data.org.name}
              />
            </TileButton>
          </li>
          {ws === null || wsName === null ? null : (
            <li>
              <TileButton
                testId="more-switch-ws"
                onClick={then(() => {
                  setSwitcher("ws");
                })}
              >
                <Tile
                  icon={ArrowLeftRight}
                  label={t("switcher.ws")}
                  sub={wsName}
                />
              </TileButton>
            </li>
          )}
        </ul>
      </SheetDialog>
      <SwitcherDialog
        title={t("switcher.org")}
        testId="more-org-switcher"
        kind="org"
        current={data.org.slug}
        choices={orgChoices(data)}
        open={switcher === "org"}
        onOpenChange={(open) => {
          setSwitcher(open ? "org" : null);
        }}
      />
      {ws === null ? null : (
        <SwitcherDialog
          title={t("switcher.ws")}
          testId="more-workspace-switcher"
          kind="ws"
          createHref={routes.orgWorkspaces(data.org.slug)}
          current={ws}
          choices={workspaceChoices(data)}
          open={switcher === "ws"}
          onOpenChange={(open) => {
            setSwitcher(open ? "ws" : null);
          }}
        />
      )}
    </>
  );
}

/** Tailwind's md breakpoint, where the rail replaces the drawer. */
export const WIDE_QUERY = "(min-width: 48rem)";

/**
 * The phone drawer: the whole sidebar over a scrim, opened from the top bar's
 * menu button, the rail's foot included, so the assistant launcher a phone
 * cannot reach in the `hidden md:flex` rail is reachable here (ADR-026).
 *
 * The drawer is a modal whose popup and scrim are `md:hidden`, so a window
 * widened past the breakpoint with it open would keep an invisible modal
 * holding focus and scroll. Crossing to wide closes it, as the mockup's
 * `S.side=false` does (audit-prompt check 15); everything else the shell
 * holds (the route, an open dialog, the drawer's own state) is left alone.
 */
export function NavDrawer({ data }: { data: ShellData }) {
  const t = useTranslations("shell.drawer");
  const { drawerOpen, setDrawerOpen } = useShellState();
  const close = () => {
    setDrawerOpen(false);
  };
  useEffect(() => {
    if (!drawerOpen || typeof window.matchMedia !== "function") return;
    const wide = window.matchMedia(WIDE_QUERY);
    if (wide.matches) {
      setDrawerOpen(false);
      return;
    }
    const onChange = (e: MediaQueryListEvent) => {
      if (e.matches) setDrawerOpen(false);
    };
    wide.addEventListener("change", onChange);
    return () => {
      wide.removeEventListener("change", onChange);
    };
  }, [drawerOpen, setDrawerOpen]);
  return (
    <Dialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop
          data-scrim=""
          className="fixed inset-0 z-50 bg-overlay-scrim md:hidden"
        />
        <Dialog.Popup
          data-testid="nav-drawer"
          className="fixed inset-y-0 left-0 z-50 flex w-[min(18.75rem,86vw)] flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar-bg pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-sidebar-fg shadow-2xl md:hidden"
        >
          {/* The mock's drawer opens on the brand and the switchers; the
              scrim and Escape close it, so it carries no close row. */}
          <Dialog.Title className="sr-only">{t("title")}</Dialog.Title>
          <SidebarHeader data={data} />
          <SidebarNav data={data} onNavigate={close} />
          <SidebarFoot onNavigate={close} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
