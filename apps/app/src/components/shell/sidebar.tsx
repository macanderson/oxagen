"use client";
/**
 * Sidebar — the floating left-nav card (stock shadcn surface, no glass).
 *
 * A rounded, bordered card that floats on the muted page canvas. Collapses to
 * an icon rail via the SidebarContext (toggled from the content-panel header).
 *
 * Layout (top → bottom):
 *   brand   — Oxagen mark (wordmark hidden in rail mode)
 *   primary — main nav items
 *   tools   — de-emphasised items (subtle separator above)
 *   footer  — pinned nav items (e.g. Settings) + the account control
 *
 * Client component: reads `usePathname()` for active state and the collapse
 * flag from `useSidebar()`.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { activeHrefFor, getSidebarConfig, resolveSidebarCtx, resolveSidebarMode } from "@/lib/sidebar";
import { SidebarItem } from "@/components/shell/sidebar-item";
import { UserSwitcher, type SessionUser } from "@/components/shell/user-switcher";
import { BrandMark, OxagenWordmark } from "@/components/ui/brand";
import { useSidebar } from "./sidebar-context";
import { cn } from "@/lib/utils";
import type { ScopeContext } from "@/lib/scope";

export interface SidebarProps {
  ctx: ScopeContext;
  /** May be undefined during a transient post-signup render; passed through to UserSwitcher which guards. */
  user: SessionUser | undefined;
}

/** Uppercase group heading shown above a sidebar section (a spacer in rail mode). */
function GroupLabel({ children, collapsed }: { children: React.ReactNode; collapsed: boolean }) {
  if (collapsed) return <div className="h-2" aria-hidden="true" />;
  return (
    <p className="px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {children}
    </p>
  );
}

/** Desktop floating sidebar — hidden on mobile, visible at `md` and above. */
export function Sidebar({ ctx, user }: SidebarProps) {
  const pathname = usePathname();
  const { collapsed } = useSidebar();
  // Recover the workspace slug from the URL (the org layout doesn't supply it),
  // then resolve the single active href as the most specific match.
  const effectiveCtx = resolveSidebarCtx(pathname, ctx);
  const mode = resolveSidebarMode(pathname, ctx);
  const config = getSidebarConfig(mode);
  const activeHref = activeHrefFor(pathname, config.items.map((item) => item.href(effectiveCtx)));

  const primary = config.items.filter((item) => (item.group ?? "primary") === "primary");
  const tools = config.items.filter((item) => item.group === "tools");
  const footer = config.items.filter((item) => item.group === "footer");

  const renderItem = (item: (typeof config.items)[number]) => {
    const href = item.href(effectiveCtx);
    const badge = item.badge ? item.badge(effectiveCtx) : undefined;
    return (
      <SidebarItem
        key={item.id}
        href={href}
        label={item.label}
        icon={item.icon}
        active={href === activeHref}
        badge={badge}
        external={item.external}
        isReturn={item.isReturn}
        collapsed={collapsed}
      />
    );
  };

  const homeHref = effectiveCtx.workspaceSlug
    ? `/${effectiveCtx.orgSlug}/${effectiveCtx.workspaceSlug}/ask`
    : `/${effectiveCtx.orgSlug}`;

  return (
    <aside
      aria-label="Primary navigation"
      data-collapsed={collapsed}
      className={cn(
        "hidden h-full shrink-0 flex-col overflow-hidden border-border bg-sidebar text-sidebar-foreground transition-[width] duration-200 md:flex",
        "md:rounded-xl md:border md:shadow-sm",
        collapsed ? "w-[3.75rem]" : "w-64",
      )}
    >
      {/* Brand header */}
      <div className={cn("flex h-14 shrink-0 items-center px-3", collapsed && "justify-center px-0")}>
        <Link href={homeHref} aria-label="Oxagen home" className="flex items-center gap-2">
          <BrandMark />
          {!collapsed && <OxagenWordmark className="text-2xl text-foreground" />}
        </Link>
      </div>

      {/* Primary + tools */}
      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2" aria-label="Workspace navigation">
        {config.groupLabel && <GroupLabel collapsed={collapsed}>{config.groupLabel}</GroupLabel>}
        {primary.map(renderItem)}

        {tools.length > 0 && (
          <>
            <div className="mx-2 my-2 h-px bg-sidebar-border" role="separator" aria-hidden="true" />
            {config.toolsLabel && <GroupLabel collapsed={collapsed}>{config.toolsLabel}</GroupLabel>}
            {tools.map(renderItem)}
          </>
        )}
      </nav>

      {/* Footer nav items + account control, pinned to the bottom. */}
      <div className="flex flex-col gap-0.5 border-t border-sidebar-border p-2">
        {footer.map(renderItem)}
        <UserSwitcher
          user={user}
          variant={collapsed ? "avatar" : "full"}
          className={collapsed ? "mx-auto" : undefined}
        />
      </div>
    </aside>
  );
}
