"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { ArrowUpRight, CornerDownLeft } from "lucide-react"
import { motion } from "framer-motion"
import { cn } from "@/lib/utils"
import type { ScopeContext, ShellMode } from "@/lib/scope"
import { sidebarRegistry, type SidebarItemConfig } from "@/lib/sidebar"
import { Badge } from "@/components/ui/badge"
import { useShell } from "./shell-context"

type SidebarProps = {
  mode: Exclude<ShellMode, "pre-shell">
  scope: ScopeContext
  collapsed?: boolean
  onNavigate?: () => void
}

function isItemActive(pathname: string, href: string, isReturn?: boolean) {
  if (isReturn) return false
  // Active when the current path is the item href or a child of it.
  return pathname === href || pathname.startsWith(href + "/")
}

function ItemLink({
  item,
  scope,
  pathname,
  collapsed,
  onNavigate,
  overrideHref,
}: {
  item: SidebarItemConfig
  scope: ScopeContext
  pathname: string
  collapsed?: boolean
  onNavigate?: () => void
  overrideHref?: string
}) {
  const href = overrideHref ?? item.href(scope)
  const active = isItemActive(pathname, href, item.isReturn)
  const Icon = item.icon
  const badge = item.badge?.(scope) ?? null

  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      title={collapsed ? item.label : undefined}
      className={cn(
        "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-all duration-200",
        "outline-none focus-visible:ring-2 focus-visible:ring-ring",
        collapsed && "justify-center px-0",
        active
          ? "bg-brand/10 text-foreground shadow-sm"
          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground hover:translate-x-0.5",
      )}
    >
      {active && (
        <motion.span
          layoutId="sidebar-indicator"
          aria-hidden="true"
          className="brand-gradient absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full"
          transition={{ type: "spring", stiffness: 500, damping: 35 }}
        />
      )}
      <Icon className="size-[18px] shrink-0" aria-hidden="true" />
      {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
      {!collapsed && item.external && (
        <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
      )}
      {!collapsed && item.isReturn && (
        <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden="true" />
      )}
      {!collapsed && badge !== null && (
        <Badge
          variant="secondary"
          className="h-5 min-w-5 justify-center px-1.5 text-[11px] tabular-nums"
        >
          {badge}
        </Badge>
      )}
    </Link>
  )
}

export function Sidebar({ mode, scope, collapsed, onNavigate }: SidebarProps) {
  const pathname = usePathname()
  const config = sidebarRegistry[mode]
  const { returnPath, lastWorkspace } = useShell()

  // The account-mode "Back to app" link returns to wherever the user came from,
  // falling back to their last-viewed workspace, then the app root.
  const returnHref =
    returnPath ??
    (lastWorkspace ? `/${lastWorkspace.org}/${lastWorkspace.ws}/ask` : undefined)

  const primary = config.items.filter((i) => (i.group ?? "primary") === "primary")
  const tools = config.items.filter((i) => i.group === "tools")
  const footer = config.items.filter((i) => i.group === "footer")

  return (
    <nav
      aria-label="Primary"
      className="flex h-full flex-col gap-1 overflow-y-auto bg-sidebar/60 px-3 py-4 backdrop-blur-xl"
    >
      {!collapsed && config.groupLabel && (
        <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {config.groupLabel}
        </p>
      )}

      <div className="flex flex-col gap-0.5">
        {primary.map((item) => (
          <ItemLink
            key={item.id}
            item={item}
            scope={scope}
            pathname={pathname}
            collapsed={collapsed}
            onNavigate={onNavigate}
            overrideHref={item.isReturn ? returnHref : undefined}
          />
        ))}
      </div>

      {tools.length > 0 && (
        <>
          <div className="my-2 h-px bg-border" aria-hidden="true" />
          {!collapsed && config.toolsLabel && (
            <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
              {config.toolsLabel}
            </p>
          )}
          <div className="flex flex-col gap-0.5">
            {tools.map((item) => (
              <ItemLink
                key={item.id}
                item={item}
                scope={scope}
                pathname={pathname}
                collapsed={collapsed}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </>
      )}

      {footer.length > 0 && (
        <div className="mt-auto flex flex-col gap-0.5 pt-2">
          <div className="mb-1 h-px bg-border" aria-hidden="true" />
          {footer.map((item) => (
            <ItemLink
              key={item.id}
              item={item}
              scope={scope}
              pathname={pathname}
              collapsed={collapsed}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </nav>
  )
}
