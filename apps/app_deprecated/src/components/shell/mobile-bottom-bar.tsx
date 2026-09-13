"use client";
/**
 * MobileBottomBar — the primary thumb-reachable navigation for sub-`md` viewports.
 *
 * Replaces the old top-left hamburger drawer entirely: every destination in the
 * app is reachable from the bottom edge of the screen, where a thumb actually
 * lands. The bar shows up to four primary destinations as client-routed tabs
 * (Next.js <Link>, not a full-page <a> reload); a fifth "More" tab opens a
 * bottom sheet holding the overflow nav items (tools, settings) plus the account
 * control (profile, theme, sign out — the only place those live on mobile now).
 *
 * Mode-aware via the same getSidebarConfig / resolveSidebarMode the desktop
 * Sidebar uses, so the mobile tabs always match the desktop nav.
 *
 * Fixed to the bottom edge; its height + breathing room is reserved by the
 * shell <main>'s padding via the --bottom-bar-h / --bottom-bar-gap custom
 * properties (globals.css), so it never covers page content or the chat
 * composer's Send button.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MoreHorizontal } from "lucide-react";
import {
  Sheet,
  SheetPopup,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import {
  UserSwitcher,
  type SessionUser,
} from "@/components/shell/user-switcher";
import {
  activeHrefFor,
  getSidebarConfig,
  resolveSidebarCtx,
  resolveSidebarMode,
} from "@/lib/sidebar";
import { cn } from "@/lib/utils";
import type { ScopeContext } from "@/lib/scope";

/** Destinations rendered directly in the bar; the rest fall into the More sheet. */
const MAX_BAR_ITEMS = 4;

export interface MobileBottomBarProps {
  ctx: ScopeContext;
  user?: SessionUser;
  /** Org subscription tier — gates enterprise-only nav items. */
  planTier?: import("@oxagen/oxagen/types").PlanTier;
}

/** Shared tab styling for both the <Link> tabs and the "More" trigger. */
function tabClass(isActive: boolean): string {
  return cn(
    "flex h-[var(--bottom-bar-h)] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 transition-colors active:scale-95",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
    isActive
      ? "text-app-link-active-fg"
      : "text-app-link-fg hover:text-app-link-hover-fg",
  );
}

/**
 * Custom DOM event dispatched by the chat surface (chat-shell-client.tsx,
 * chat_ux_v2 mobile chrome only) to tuck the bar away while the user reads
 * the transcript or has the on-screen keyboard open, maximising the
 * conversation's share of the viewport. Flag-independent — any surface can
 * dispatch it; the bar just listens.
 */
const NAV_VISIBILITY_EVENT = "oxagen:mobile-nav-visibility";

export function MobileBottomBar({ ctx, user, planTier }: MobileBottomBarProps) {
  const [moreOpen, setMoreOpen] = React.useState(false);
  const [hidden, setHidden] = React.useState(false);
  const pathname = usePathname();

  React.useEffect(() => {
    function onVisibility(e: Event) {
      const detail = (e as CustomEvent<{ hidden: boolean }>).detail;
      if (detail && typeof detail.hidden === "boolean")
        setHidden(detail.hidden);
    }
    window.addEventListener(NAV_VISIBILITY_EVENT, onVisibility);
    return () => window.removeEventListener(NAV_VISIBILITY_EVENT, onVisibility);
  }, []);
  const effectiveCtx = resolveSidebarCtx(pathname, ctx);
  const mode = resolveSidebarMode(pathname, ctx);
  const config = getSidebarConfig(mode, planTier);

  const items = config.items;
  // Active detection runs over EVERY item (not just the visible four) so a deep
  // page that lives behind "More" highlights the More tab rather than nothing.
  const activeHref = activeHrefFor(
    pathname,
    items.map((item) => item.href(effectiveCtx)),
  );

  const barItems = items.slice(0, MAX_BAR_ITEMS);
  const moreItems = items.slice(MAX_BAR_ITEMS);

  if (barItems.length === 0) return null;

  const moreActive = moreItems.some(
    (item) => item.href(effectiveCtx) === activeHref,
  );
  // Only surface "More" when its sheet would have content — overflow nav items
  // and/or the account control. Prevents opening a header-only empty sheet (e.g.
  // an org route with ≤4 items during a transient user=undefined render).
  const showMore = moreItems.length > 0 || Boolean(user);

  return (
    <>
      <nav
        aria-label="Mobile navigation"
        // Marker consumed by globals.css: when this bar is mounted, fixed
        // bottom overlays (e.g. the PWA install toast) offset above it via
        // `--pwa-toast-bottom` instead of covering the tabs.
        data-mobile-bottom-bar=""
        data-hidden={hidden ? "true" : undefined}
        className={cn(
          "fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around md:hidden",
          "border-t border-app-topbar-border bg-app-topbar-bg pb-[env(safe-area-inset-bottom)]",
          "transition-transform duration-200 motion-reduce:transition-none",
          hidden && "translate-y-full",
        )}
      >
        {barItems.map((item) => {
          const href = item.href(effectiveCtx);
          const isActive = href === activeHref;
          const Icon = item.icon;
          return (
            <Link
              key={item.id}
              href={href}
              // No aria-label: the visible label text is the accessible name.
              aria-current={isActive ? "page" : undefined}
              className={tabClass(isActive)}
            >
              <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
              <span className="truncate text-[10px] font-medium">
                {item.label}
              </span>
            </Link>
          );
        })}

        {/* "More" — opens a bottom sheet with the overflow items + account control. */}
        {showMore ? (
          <button
            type="button"
            aria-label="More navigation"
            aria-haspopup="dialog"
            aria-expanded={moreOpen}
            aria-current={moreActive ? "page" : undefined}
            onClick={() => setMoreOpen(true)}
            className={tabClass(moreActive)}
          >
            <MoreHorizontal className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span className="truncate text-[10px] font-medium">More</span>
          </button>
        ) : null}
      </nav>

      {showMore ? (
        <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
          <SheetPopup
            side="bottom"
            className="flex max-h-[80vh] flex-col gap-0 rounded-t-2xl p-0 pb-[env(safe-area-inset-bottom)]"
          >
            <SheetHeader className="border-b px-4 py-3 text-left">
              <SheetTitle>More</SheetTitle>
              <SheetDescription className="sr-only">
                Additional navigation and account options
              </SheetDescription>
            </SheetHeader>

            {moreItems.length > 0 ? (
              <nav
                className="flex flex-col gap-0.5 overflow-y-auto p-2"
                aria-label="More destinations"
              >
                {moreItems.map((item) => {
                  const href = item.href(effectiveCtx);
                  const isActive = href === activeHref;
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.id}
                      href={href}
                      aria-current={isActive ? "page" : undefined}
                      // Close the sheet on navigation; Link keeps proper client
                      // routing + link semantics (a nav item is a link, not a button).
                      onClick={() => setMoreOpen(false)}
                      className={cn(
                        "flex min-h-[2.75rem] items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                        isActive
                          ? "bg-sidebar-nav-link-active-bg text-sidebar-nav-link-active-fg"
                          : "text-sidebar-nav-link-fg hover:bg-sidebar-nav-link-hover-bg hover:text-sidebar-nav-link-hover-fg",
                      )}
                    >
                      <Icon
                        className={cn(
                          "h-4 w-4 shrink-0",
                          isActive
                            ? "text-sidebar-nav-link-active-fg"
                            : "text-muted-foreground",
                        )}
                        aria-hidden="true"
                      />
                      <span className="flex-1 truncate">{item.label}</span>
                    </Link>
                  );
                })}
              </nav>
            ) : null}

            {/* Account control — the sole home for profile / theme / sign out on mobile. */}
            {user ? (
              <div className="border-t p-2">
                <UserSwitcher user={user} variant="full" />
              </div>
            ) : null}
          </SheetPopup>
        </Sheet>
      ) : null}
    </>
  );
}
