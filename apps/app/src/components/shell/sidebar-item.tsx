/**
 * SidebarItem — a single navigation row in the application shell sidebar.
 *
 * Integration contract:
 *   import { SidebarItem } from "@/components/shell/sidebar-item"
 *   <SidebarItem
 *     href="/acme/production/chat"
 *     label="Chat"
 *     icon={MessageSquare}
 *     active={true}
 *   />
 *
 * Visual states:
 *   active   — 3px left accent bar + muted background
 *   external — renders an ↗ icon (ArrowUpRight) on the right edge
 *   isReturn — renders a ← icon (ArrowLeft) on the left, before the main icon
 *
 * Mobile: min 44px tap target via py-2.5.
 *
 * Pure affordance logic lives in @/lib/sidebar-item-affordance (node-testable).
 */

import Link from "next/link";
import { ArrowUpRight, ArrowLeft, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { sidebarItemAffordance } from "@/lib/sidebar-item-affordance";

// Re-export types so callers can import from one place
export type { SidebarItemAffordance } from "@/lib/sidebar-item-affordance";
export { sidebarItemAffordance } from "@/lib/sidebar-item-affordance";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface SidebarItemProps {
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  badge?: number | null;
  /** Shows ↗ arrow affordance — signals navigation to a different mode. */
  external?: boolean;
  /** Shows ← arrow affordance — signals "back to previous mode". */
  isReturn?: boolean;
  className?: string;
}

export function SidebarItem({
  href,
  label,
  icon: Icon,
  active,
  badge,
  external = false,
  isReturn = false,
  className,
}: SidebarItemProps) {
  const affordance = sidebarItemAffordance({ external, isReturn });

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={cn(
        // Layout: flex row, icon + label + badge, full-width, mobile tap target
        "group relative flex min-h-[2.75rem] w-full items-center gap-2.5 rounded-md",
        "px-3 py-2.5 text-sm font-medium",
        // Transition
        "transition-colors",
        // Focus ring
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        // Inactive state
        !active &&
          "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        // Active state
        active && "bg-sidebar-accent text-sidebar-accent-foreground",
        className,
      )}
    >
      {/* 2px left accent bar — active only */}
      {active && (
        <span
          className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-sidebar-primary"
          aria-hidden="true"
        />
      )}

      {/* Return arrow (←) — appears before the icon when isReturn */}
      {affordance === "return" && (
        <ArrowLeft
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60"
          aria-hidden="true"
        />
      )}

      {/* Primary icon */}
      <Icon
        className={cn(
          "h-4 w-4 shrink-0",
          active ? "text-foreground" : "text-muted-foreground group-hover:text-foreground",
          "transition-colors duration-[160ms]",
        )}
        aria-hidden="true"
      />

      {/* Label */}
      <span className="flex-1 truncate">{label}</span>

      {/* Optional numeric badge */}
      {badge != null && badge > 0 && (
        <span
          className={cn(
            "inline-flex h-4.5 min-w-[1.125rem] items-center justify-center rounded-full px-1",
            "text-[10px] font-semibold leading-none",
            active ? "bg-sidebar-primary text-sidebar-primary-foreground" : "bg-muted text-muted-foreground",
          )}
          aria-label={`${badge} items`}
        >
          {badge}
        </span>
      )}

      {/* External arrow (↗) */}
      {affordance === "external" && (
        <ArrowUpRight
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-muted-foreground"
          aria-hidden="true"
        />
      )}
    </Link>
  );
}
