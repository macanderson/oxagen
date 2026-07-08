"use client";

/**
 * SettingsNav — vertical sidebar navigation for settings pages (md+ viewports),
 * plus MobileSettingsNav — the sub-md, one-thumb equivalent of the same list.
 *
 * SettingsNav renders a list of nav links in a left-hand column. Active link is
 * determined by longest-prefix match against the current pathname (same logic
 * as PageTabs).
 *
 * MobileSettingsNav re-presents the identical items as a sticky section
 * switcher pinned just above the app's MobileBottomBar (the bottom edge is the
 * thumb's home zone — a left sidebar or top tab strip is not reachable
 * one-handed). Tapping it opens a bottom sheet listing every section with
 * ≥44px targets. Feature parity is law (ADR-026): both components must always
 * receive the same `items`.
 *
 * Integration contract (render both from a settings layout):
 *   <aside className="hidden w-48 shrink-0 md:block"><SettingsNav items={items} /></aside>
 *   <MobileSettingsNav items={items} label="Workspace settings" />
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronsUpDown } from "lucide-react";
import {
  Sheet,
  SheetPopup,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { resolveActiveTab } from "@/lib/resolve-active-tab";

export interface SettingsNavItem {
  label: string;
  href: string;
}

export interface SettingsNavProps {
  items: SettingsNavItem[];
  className?: string;
}

export function SettingsNav({ items, className }: SettingsNavProps) {
  const pathname = usePathname();
  const activeHref = resolveActiveTab(items, pathname);

  return (
    <nav
      aria-label="Settings"
      className={cn("flex flex-col gap-0.5", className)}
    >
      {items.map((item) => {
        const isActive = item.href === activeHref;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "relative rounded-md px-3 py-2 text-sm font-medium",
              "transition-colors duration-150",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
              isActive
                ? "bg-muted text-foreground"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

export interface MobileSettingsNavProps {
  items: SettingsNavItem[];
  /** Sheet heading, e.g. "Workspace settings" / "Organization settings". */
  label: string;
  className?: string;
}

/**
 * MobileSettingsNav — sub-md section switcher for settings pages.
 *
 * Sticky wrapper pinned above the fixed MobileBottomBar (same offset math as
 * the agent-builder step nav); `-mx-4 px-4` bleeds across the shell <main>'s
 * mobile `p-4` padding so the bar spans the full viewport width.
 */
export function MobileSettingsNav({ items, label, className }: MobileSettingsNavProps) {
  const [open, setOpen] = React.useState(false);
  const pathname = usePathname();
  const activeHref = resolveActiveTab(items, pathname);
  const active = items.find((item) => item.href === activeHref);

  if (items.length === 0) return null;

  return (
    <>
      <div
        className={cn(
          "sticky bottom-[calc(var(--bottom-bar-h)+var(--bottom-bar-gap,0px)+env(safe-area-inset-bottom))] z-10",
          "-mx-4 mt-6 border-t border-border/60 bg-background/95 px-4 py-2 backdrop-blur md:hidden",
          className,
        )}
      >
        <button
          type="button"
          data-testid="settings-mobile-nav-trigger"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          className={cn(
            "flex h-11 w-full items-center justify-between gap-2 rounded-md border border-border/60",
            "bg-muted/40 px-4 text-sm font-medium text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <span className="truncate">{active?.label ?? label}</span>
          <span className="flex items-center gap-1.5 text-xs font-normal text-muted-foreground">
            {label}
            <ChevronsUpDown className="size-4 shrink-0" aria-hidden="true" />
          </span>
        </button>
      </div>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetPopup
          side="bottom"
          className="flex max-h-[80vh] flex-col gap-0 rounded-t-2xl p-0 pb-[env(safe-area-inset-bottom)]"
        >
          <SheetHeader className="border-b px-4 py-3 text-left">
            <SheetTitle>{label}</SheetTitle>
            <SheetDescription className="sr-only">
              Choose a settings section
            </SheetDescription>
          </SheetHeader>
          <nav
            aria-label="Settings"
            className="flex flex-col gap-0.5 overflow-y-auto p-2"
            data-testid="settings-mobile-nav-sheet"
          >
            {items.map((item) => {
              const isActive = item.href === activeHref;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  // Close the sheet on navigation; Link keeps client routing
                  // + link semantics (a nav item is a link, not a button).
                  onClick={() => setOpen(false)}
                  className={cn(
                    "flex min-h-[2.75rem] items-center rounded-md px-3 py-2.5 text-sm font-medium",
                    "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    isActive
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </SheetPopup>
      </Sheet>
    </>
  );
}
