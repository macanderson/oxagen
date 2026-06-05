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
 * Visual states (neutral coss/Base UI tokens — no brand styling):
 *   active   — `bg-sidebar-accent` + `text-sidebar-accent-foreground`
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
  /** Icon-rail mode: hide the label/badge/affordances, center the icon. */
  collapsed?: boolean;
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
  collapsed = false,
  className,
}: SidebarItemProps) {
  const affordance = sidebarItemAffordance({ external, isReturn });

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? label : undefined}
      title={collapsed ? label : undefined}
      className={cn(
        // Layout: flex row, icon + label + badge, full-width, mobile tap target
        "group relative flex min-h-[2.75rem] w-full items-center gap-2.5 rounded-md",
        "px-3 py-2.5 text-sm font-medium",
        // Rail mode: center the icon, drop horizontal padding
        collapsed && "justify-center gap-0 px-0",
        // Transition
        "transition-colors",
        // Focus ring
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        // Inactive — neutral hover
        !active && "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        // Active — neutral accent fill
        active && "bg-sidebar-accent text-sidebar-accent-foreground",
        className,
      )}
    >
      {/* Return arrow (←) — appears before the icon when isReturn (full mode only) */}
      {!collapsed && affordance === "return" && (
        <ArrowLeft
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60"
          aria-hidden="true"
        />
      )}

      {/* Primary icon */}
      <Icon
        className={cn(
          "h-4 w-4 shrink-0 transition-colors",
          active
            ? "text-sidebar-accent-foreground"
            : "text-muted-foreground group-hover:text-sidebar-accent-foreground",
        )}
        aria-hidden="true"
      />

      {/* Label */}
      {!collapsed && <span className="flex-1 truncate">{label}</span>}

      {/* Optional numeric badge */}
      {!collapsed && badge != null && badge > 0 && (
        <span
          className={cn(
            "inline-flex h-4.5 min-w-[1.125rem] items-center justify-center rounded-full px-1",
            "text-[10px] font-semibold leading-none",
            "bg-muted text-muted-foreground",
          )}
          aria-label={`${badge} items`}
        >
          {badge}
        </span>
      )}

      {/* External arrow (↗) */}
      {!collapsed && affordance === "external" && (
        <ArrowUpRight
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-muted-foreground"
          aria-hidden="true"
        />
      )}
    </Link>
  );
}
