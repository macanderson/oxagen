"use client";
/**
 * Sidebar — mode-aware application shell sidebar (stock shadcn surface).
 *
 * Derives SidebarMode from the current pathname + ScopeContext, then renders
 * the groups from getSidebarConfig using the SidebarItem component.
 *
 * Layout (top → bottom):
 *   primary — main nav items
 *   tools   — de-emphasised items (subtle separator above)
 *   footer  — pinned nav items (e.g. Settings)
 *   user    — UserSwitcher pinned to the very bottom of the sidenav
 *
 * Client component because it reads `usePathname()`.
 */

import * as React from "react";
import { usePathname } from "next/navigation";
import { getSidebarConfig, resolveSidebarMode } from "@/lib/sidebar";
import { SidebarItem } from "@/components/shell/sidebar-item";
import { cn } from "@/lib/utils";
import type { ScopeContext } from "@/lib/scope";

export interface SidebarProps {
  ctx: ScopeContext;
}

/** Uppercase group heading shown above a sidebar section. */
function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
      {children}
    </p>
  );
}

/** Desktop sidebar — hidden on mobile, visible at `md` and above. */
export function Sidebar({ ctx }: SidebarProps) {
  const pathname = usePathname();
  const mode = resolveSidebarMode(pathname, ctx);
  const config = getSidebarConfig(mode);

  const primary = config.items.filter((item) => (item.group ?? "primary") === "primary");
  const tools = config.items.filter((item) => item.group === "tools");
  const footer = config.items.filter((item) => item.group === "footer");

  const renderItem = (item: (typeof config.items)[number]) => {
    const href = item.href(ctx);
    const badge = item.badge ? item.badge(ctx) : undefined;
    return (
      <SidebarItem
        key={item.id}
        href={href}
        label={item.label}
        icon={item.icon}
        active={pathname === href || (href !== "/" && pathname.startsWith(href + "/"))}
        badge={badge}
        external={item.external}
        isReturn={item.isReturn}
      />
    );
  };

  return (
    <aside
      aria-label="Primary navigation"
      className="hidden h-full w-64 flex-col border-r border-sidebar-border bg-sidebar/60 text-sidebar-foreground backdrop-blur-xl md:flex"
    >
      {/* Primary group */}
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2" aria-label="Workspace navigation">
        {config.groupLabel && <GroupLabel>{config.groupLabel}</GroupLabel>}
        {primary.map(renderItem)}

        {/* Tools group — its own labelled section, separated by a divider */}
        {tools.length > 0 && (
          <>
            <div className="mx-2 my-2 h-px bg-sidebar-border" role="separator" aria-hidden="true" />
            {config.toolsLabel && <GroupLabel>{config.toolsLabel}</GroupLabel>}
            {tools.map(renderItem)}
          </>
        )}
      </nav>

      {/* Footer nav items — pinned bottom (account control now lives in the topbar) */}
      {footer.length > 0 && (
        <div className="flex flex-col gap-0.5 border-t border-sidebar-border p-2">
          {footer.map(renderItem)}
        </div>
      )}
    </aside>
  );
}

/** Mobile bottom tab bar — visible below `md`, hidden at `md` and above. */
export function MobileBottomBar({ ctx }: { ctx: ScopeContext }) {
  const pathname = usePathname();
  const mode = resolveSidebarMode(pathname, ctx);
  const config = getSidebarConfig(mode);

  // Bottom bar shows primary items only (max 5); footer + tools visible in drawer.
  const primary = config.items.filter((item) => (item.group ?? "primary") === "primary").slice(0, 5);

  if (primary.length === 0) return null;

  return (
    <nav
      aria-label="Mobile navigation"
      className="glass fixed inset-x-0 bottom-0 z-40 flex items-center justify-around border-t pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      {primary.map((item) => {
        const href = item.href(ctx);
        const isActive = pathname === href || (href !== "/" && pathname.startsWith(href + "/"));
        const Icon = item.icon;
        return (
          <a
            key={item.id}
            href={href}
            aria-label={item.label}
            aria-current={isActive ? "page" : undefined}
            className={cn(
              "flex min-w-0 flex-1 flex-col items-center gap-0.5 px-1 py-2 transition-colors active:scale-95",
              isActive ? "text-brand" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="h-5 w-5 shrink-0" aria-hidden="true" />
            <span className="truncate text-[10px] font-medium">{item.label}</span>
          </a>
        );
      })}
    </nav>
  );
}
