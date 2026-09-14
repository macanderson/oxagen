"use client";
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
 * Visual states (sidebar nav-link component tokens — see AGENTS.md "Design
 * Token Usage in Shell Components"):
 *   active   — `bg-sidebar-nav-link-active-bg` + `text-sidebar-nav-link-active-fg`,
 *              plus a `bg-sidebar-primary` accent bar on the left edge
 *   inactive — `text-sidebar-nav-link-fg`, hovering to the nav-link hover pair
 *   external — renders an ↗ icon (ArrowUpRight) on the right edge
 *   isReturn — renders a ← icon (ArrowLeft) on the left, replacing the main icon
 *              in full mode (the rail keeps the main icon so the row has a glyph)
 *
 * Mobile: min 44px tap target via min-h-[2.75rem] + py-2.5.
 *
 * Pure affordance logic lives in ./sidebar-item-affordance (node-testable).
 */

import Link from "next/link";
import { ArrowUpRight, ArrowLeft, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipTrigger, TooltipPopup } from "@/components/ui/tooltip";
import { sidebarItemAffordance } from "./sidebar-item-affordance";

// Re-export types so callers can import from one place
export type { SidebarItemAffordance } from "./sidebar-item-affordance";
export { sidebarItemAffordance } from "./sidebar-item-affordance";

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
  /** When provided, renders a <button> that calls onClick instead of a <Link>. */
  onClick?: () => void;
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
  onClick,
}: SidebarItemProps) {
  const affordance = sidebarItemAffordance({ external, isReturn });

  const sharedClasses = cn(
    // Layout: flex row, icon + label + badge, full-width, mobile tap target
    "group relative flex min-h-[2.75rem] w-full items-center gap-2.5 rounded-md",
    "px-3 py-2.5 text-sm font-medium",
    // Rail mode: center the icon, drop horizontal padding
    collapsed && "justify-center gap-0 px-0",
    // Transition — design-system micro easing for hover micro-interactions
    "[transition:background-color_var(--motion-micro)_var(--ease-hover),color_var(--motion-micro)_var(--ease-hover)]",
    // Focus ring
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
    // Inactive — neutral hover (nav-link component tokens)
    !active &&
      "text-sidebar-nav-link-fg hover:bg-sidebar-nav-link-hover-bg hover:text-sidebar-nav-link-hover-fg",
    // Active — nav-link active fill
    active && "bg-sidebar-nav-link-active-bg text-sidebar-nav-link-active-fg",
    className,
  );

  const children = (
    <>
      {/* Active indicator — a brand-accent bar on the left edge, the natural home
          of the --sidebar-primary token (rail keeps it; it stays inside px-0). */}
      {active && (
        <span
          aria-hidden="true"
          className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-sidebar-primary"
        />
      )}

      {/* Return arrow (←) — appears before the icon when isReturn (full mode only) */}
      {!collapsed && affordance === "return" && (
        <ArrowLeft
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60"
          aria-hidden="true"
        />
      )}

      {/* Primary icon — skipped in full mode for return items, where the ←
          affordance above already stands in for it (rendering both produces a
          duplicate arrow, e.g. the "Back to app" item whose icon is also
          ArrowLeft). Still shown in the collapsed rail so the row keeps a
          glyph to tap. */}
      {(collapsed || affordance !== "return") && (
        <Icon
          className={cn(
            "h-4 w-4 shrink-0 [transition:color_var(--motion-micro)_var(--ease-hover)]",
            active
              ? "text-sidebar-nav-link-active-fg"
              : "text-muted-foreground group-hover:text-sidebar-nav-link-hover-fg",
          )}
          aria-hidden="true"
        />
      )}

      {/* Label */}
      {!collapsed && <span className="flex-1 truncate">{label}</span>}

      {/* Optional numeric badge */}
      {!collapsed && badge != null && badge > 0 && (
        <span
          className={cn(
            "inline-flex h-4.5 min-w-[1.125rem] items-center justify-center rounded-full px-1",
            "text-[10px] font-semibold leading-none",
            // Active rows accent the badge with the sidebar brand token pair.
            active
              ? "bg-sidebar-primary text-sidebar-primary-foreground"
              : "bg-muted text-muted-foreground",
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
    </>
  );

  if (onClick) {
    if (collapsed) {
      return (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                onClick={onClick}
                aria-label={label}
                className={sharedClasses}
              />
            }
          >
            {children}
          </TooltipTrigger>
          <TooltipPopup side="right">{label}</TooltipPopup>
        </Tooltip>
      );
    }
    return (
      <button type="button" onClick={onClick} className={sharedClasses}>
        {children}
      </button>
    );
  }

  if (collapsed) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <Link
              href={href}
              aria-current={active ? "page" : undefined}
              aria-label={label}
              className={sharedClasses}
            />
          }
        >
          {children}
        </TooltipTrigger>
        <TooltipPopup side="right">{label}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={sharedClasses}
    >
      {children}
    </Link>
  );
}
