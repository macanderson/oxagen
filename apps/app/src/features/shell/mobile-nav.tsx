"use client";
// <MobileNav>: the phone navigation seam (feedback 3, plan §6 Q3). One-thumb
// mobile navigation still needs a design; this is the plain first version, a
// bottom bar with the four most-used pages and "More" for the full sidebar in a
// drawer. The design drops in behind the same props.
import { Dialog } from "@base-ui/react/dialog";
import { Ellipsis, X } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import type { NavItem, NavKey, NavSection } from "./nav";
import { isNavItemCurrent } from "./nav";
import { NAV_ICONS } from "./nav-icons";
import {
  SidebarFooter,
  SidebarHeader,
  SidebarNav,
  useSidebarSections,
} from "./sidebar";
import type { ShellData } from "./shell-data";
import { useShellState } from "./shell-state";

/** The pages the bar carries directly, in order; the rest are one tap away under "More". */
export const MOBILE_PRIMARY: readonly NavKey[] = [
  "fleet",
  "agents",
  "tools",
  "spend",
];

export function mobileItems(sections: readonly NavSection[]): NavItem[] {
  const all = sections.flatMap((s) => s.items);
  const primary = MOBILE_PRIMARY.flatMap((key) =>
    all.filter((i) => i.key === key),
  );
  // An organization with no workspace has no workspace items: fall back to the organization pages.
  return primary.length > 0 ? primary : all.slice(0, MOBILE_PRIMARY.length);
}

export type MobileNavProps = {
  items: readonly NavItem[];
  pathname: string;
  onMore: () => void;
};

/** The seam: a plain bottom bar. Replace the body, keep the props. */
export function MobileNav({ items, pathname, onMore }: MobileNavProps) {
  const t = useTranslations("shell");
  return (
    <nav
      aria-label={t("mobileNav.label")}
      data-testid="mobile-nav"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-app-topbar-border bg-app-topbar-bg pb-[env(safe-area-inset-bottom)] text-app-topbar-fg md:hidden"
    >
      <ul className="grid grid-cols-5">
        {items.map((item) => {
          const Icon = NAV_ICONS[item.key];
          const current = isNavItemCurrent(item.key, pathname);
          return (
            <li key={item.key}>
              <Link
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={`flex min-h-14 flex-col items-center justify-center gap-1 px-1 text-[11px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring ${
                  current
                    ? "font-semibold text-app-topbar-fg"
                    : "text-app-link-fg"
                }`}
              >
                <Icon
                  aria-hidden="true"
                  className={`size-5 ${current ? "text-primary" : ""}`}
                />
                <span className="max-w-full truncate">
                  {t(`nav.${item.key}`)}
                </span>
              </Link>
            </li>
          );
        })}
        <li>
          <button
            type="button"
            onClick={onMore}
            className="flex min-h-14 w-full flex-col items-center justify-center gap-1 px-1 text-[11px] text-app-link-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          >
            <Ellipsis aria-hidden="true" className="size-5" />
            {t("mobileNav.more")}
          </button>
        </li>
      </ul>
    </nav>
  );
}

/** The phone drawer: the whole sidebar, opened from the top bar's menu button or "More". */
export function NavDrawer({ data }: { data: ShellData }) {
  const t = useTranslations("shell.drawer");
  const { drawerOpen, setDrawerOpen } = useShellState();
  const close = () => {
    setDrawerOpen(false);
  };
  return (
    <Dialog.Root open={drawerOpen} onOpenChange={setDrawerOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-overlay-scrim md:hidden" />
        <Dialog.Popup
          data-testid="nav-drawer"
          className="fixed inset-y-0 left-0 z-50 flex w-[min(18rem,85vw)] flex-col overflow-y-auto border-r border-sidebar-border bg-sidebar-bg text-sidebar-fg shadow-2xl md:hidden"
        >
          <div className="flex items-center px-3 pt-3">
            <Dialog.Title className="sr-only">{t("title")}</Dialog.Title>
            <Dialog.Close
              aria-label={t("close")}
              className="ml-auto rounded-sm p-1 text-sidebar-nav-label-fg hover:text-sidebar-fg focus-visible:outline-2 focus-visible:outline-ring"
            >
              <X aria-hidden="true" className="size-4" />
            </Dialog.Close>
          </div>
          <SidebarHeader data={data} />
          <SidebarNav data={data} onNavigate={close} />
          <SidebarFooter data={data} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** <MobileNav> wired to the shell: items from the sidebar model, "More" opens the drawer. */
export function ShellMobileNav({ data }: { data: ShellData }) {
  const { sections, pathname } = useSidebarSections(data);
  const { setDrawerOpen } = useShellState();
  return (
    <MobileNav
      items={mobileItems(sections)}
      pathname={pathname}
      onMore={() => {
        setDrawerOpen(true);
      }}
    />
  );
}
