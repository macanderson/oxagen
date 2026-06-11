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
import { UserSwitcher, type SessionUser } from "@/components/shell/user-switcher";
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
  /**
   * The authenticated user. May be undefined during a transient post-signup
   * render; the account section is omitted in that case (UserSwitcher self-guards).
   */
  user?: SessionUser;
}

/** Shared tab styling for both the <Link> tabs and the "More" trigger. */
function tabClass(isActive: boolean): string {
  return cn(
    "flex h-[var(--bottom-bar-h)] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 transition-colors active:scale-95",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
    isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
  );
}

export function MobileBottomBar({ ctx, user }: MobileBottomBarProps) {
  const [moreOpen, setMoreOpen] = React.useState(false);
  const pathname = usePathname();
  const effectiveCtx = resolveSidebarCtx(pathname, ctx);
  const mode = resolveSidebarMode(pathname, ctx);
  const config = getSidebarConfig(mode);

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

  const moreActive = moreItems.some((item) => item.href(effectiveCtx) === activeHref);

  return (
    <>
      <nav
        aria-label="Mobile navigation"
        className={cn(
          "fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around md:hidden",
          "border-t border-border bg-background pb-[env(safe-area-inset-bottom)]",
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
              aria-label={item.label}
              aria-current={isActive ? "page" : undefined}
              className={tabClass(isActive)}
            >
              <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
              <span className="truncate text-[10px] font-medium">{item.label}</span>
            </Link>
          );
        })}

        {/* "More" — opens a bottom sheet with the overflow items + account control. */}
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
      </nav>

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
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    )}
                  >
                    <Icon
                      className={cn(
                        "h-4 w-4 shrink-0",
                        isActive
                          ? "text-sidebar-accent-foreground"
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
    </>
  );
}
