/**
 * PageTabs — a horizontal WAI-ARIA tablist where each tab is a next/link Link.
 * Active tab is determined by longest-prefix match against the current pathname.
 *
 * Integration contract:
 *   import { PageTabs } from "@/components/ui/page-tabs"
 *   <PageTabs
 *     tabs={[
 *       { label: "Overview", href: "/acme/billing" },
 *       { label: "Invoices", href: "/acme/billing/invoices", badge: 3 },
 *     ]}
 *   />
 *
 * Pure resolution logic lives in @/lib/resolve-active-tab (node-testable).
 */

"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { resolveActiveTab } from "@/lib/resolve-active-tab";

// Re-export so callers can import from one place if needed
export { resolveActiveTab } from "@/lib/resolve-active-tab";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface PageTab {
  label: string;
  href: string;
  badge?: number | null;
}

export interface PageTabsProps {
  tabs: PageTab[];
  className?: string;
}

export function PageTabs({ tabs, className }: PageTabsProps) {
  const pathname = usePathname();
  const activeHref = resolveActiveTab(tabs, pathname);

  return (
    /*
     * Outer wrapper: horizontally scrollable, edge-faded when overflowing.
     * The gradient masks are purely decorative and hidden to assistive tech.
     */
    <div
      className={cn("relative", className)}
      // Fade right edge when overflow is present — pure CSS, no JS needed.
      // We use a mask-image applied to the scroll container's pseudo-element
      // via a wrapping div approach to keep the indicator visible at the edge.
    >
      {/* Left + right gradient masks */}
      <div
        className="pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-background to-transparent"
        aria-hidden="true"
      />
      <div
        className="pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l from-background to-transparent"
        aria-hidden="true"
      />

      <div
        role="tablist"
        aria-label="Page sections"
        className="flex items-end gap-0 overflow-x-auto scrollbar-none border-b border-border/40 pl-0"
        style={{ scrollbarWidth: "none" } as React.CSSProperties}
      >
        {tabs.map((tab) => {
          const isActive = tab.href === activeHref;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              role="tab"
              aria-selected={isActive}
              tabIndex={isActive ? 0 : -1}
              className={cn(
                // Base tab styles — no wrapping, px spacing, consistent height
                "relative flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 pb-2.5 pt-1.5",
                "text-sm font-medium leading-none",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
                "transition-colors duration-150",
                // State
                isActive
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground/80",
              )}
            >
              {tab.label}

              {/* Numeric badge */}
              {tab.badge != null && tab.badge > 0 && (
                <span
                  className={cn(
                    "inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full px-1",
                    "text-[10px] font-semibold leading-none",
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground",
                  )}
                  aria-label={`${tab.badge} items`}
                >
                  {tab.badge}
                </span>
              )}

              {/* Active indicator — 2px bottom bar */}
              {isActive && (
                <span
                  className="bg-foreground absolute inset-x-0 bottom-0 h-0.5 rounded-full"
                  aria-hidden="true"
                />
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
