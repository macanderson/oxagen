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
import { motion } from "motion/react";
import { cn } from "@/lib/utils";
import { resolveActiveTab } from "@/lib/resolve-active-tab";
import { transition } from "@oxagen/ui/lib/motion";

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

  // Edge fades are scroll affordances: each one is shown ONLY when there is
  // actually content scrolled off that side. They must never render at rest —
  // the left fade would sit over the first tab's active indicator and wash the
  // underline out to a background→transparent gradient.
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = React.useState(false);
  const [canScrollRight, setCanScrollRight] = React.useState(false);

  const updateFades = React.useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const { scrollLeft, scrollWidth, clientWidth } = el;
    setCanScrollLeft(scrollLeft > 1);
    // 1px slack absorbs sub-pixel rounding at the far edge.
    setCanScrollRight(scrollLeft < scrollWidth - clientWidth - 1);
  }, []);

  React.useEffect(() => {
    updateFades();
    const el = scrollerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(updateFades);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateFades, tabs]);

  // Roving-tabindex keyboard navigation. With only the active tab in the tab
  // order (tabIndex 0 vs -1), a keyboard user otherwise can't reach the other
  // tabs at all — the WAI-ARIA tablist pattern requires Arrow/Home/End to move
  // focus between tabs. Focus only (manual activation): Enter follows the link.
  const tabRefs = React.useRef<(HTMLAnchorElement | null)[]>([]);
  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const count = tabs.length;
      if (count === 0) return;
      const current = tabRefs.current.findIndex(
        (el) => el === document.activeElement,
      );
      let next = -1;
      switch (e.key) {
        case "ArrowRight":
          next = current < 0 ? 0 : (current + 1) % count;
          break;
        case "ArrowLeft":
          next = current < 0 ? 0 : (current - 1 + count) % count;
          break;
        case "Home":
          next = 0;
          break;
        case "End":
          next = count - 1;
          break;
        default:
          return;
      }
      e.preventDefault();
      tabRefs.current[next]?.focus();
    },
    [tabs.length],
  );

  return (
    /*
     * Outer wrapper: horizontally scrollable, edge-faded when overflowing.
     * The gradient masks are purely decorative and hidden to assistive tech.
     */
    <div className={cn("relative", className)}>
      {/* Left + right gradient masks — opacity-gated on actual overflow. */}
      <div
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 z-10 w-6 bg-gradient-to-r from-background to-transparent transition-opacity duration-150",
          canScrollLeft ? "opacity-100" : "opacity-0",
        )}
        aria-hidden="true"
      />
      <div
        className={cn(
          "pointer-events-none absolute inset-y-0 right-0 z-10 w-8 bg-gradient-to-l from-background to-transparent transition-opacity duration-150",
          canScrollRight ? "opacity-100" : "opacity-0",
        )}
        aria-hidden="true"
      />

      <div
        ref={scrollerRef}
        onScroll={updateFades}
        onKeyDown={handleKeyDown}
        role="tablist"
        aria-label="Page sections"
        className="flex items-end gap-0 overflow-x-auto scrollbar-none border-b border-border/40 pl-0"
        style={{ scrollbarWidth: "none" } as React.CSSProperties}
      >
        {tabs.map((tab, index) => {
          const isActive = tab.href === activeHref;
          return (
            <Link
              key={tab.href}
              ref={(el) => {
                tabRefs.current[index] = el;
              }}
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

              {/* Active indicator — shared-layout sliding 2px bottom bar */}
              {isActive && (
                <motion.span
                  layoutId="page-tab-indicator"
                  className="brand-gradient absolute inset-x-0 bottom-0 h-0.5 rounded-full"
                  aria-hidden="true"
                  transition={transition.entry}
                />
              )}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
