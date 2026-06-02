"use client"

import { useMemo, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import { Check, ChevronsUpDown, Clock, Plus, Search, Settings2 } from "lucide-react"
import { cn } from "@/lib/utils"
import { buildWorkspaceSwitchPath } from "@/lib/scope"
import { getOrg, getWorkspace } from "@/lib/mock-data"
import { useShell } from "./shell-context"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export function WorkspaceSwitcher({
  currentOrg,
  currentWs,
}: {
  currentOrg: string
  currentWs?: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const { setLastWorkspace, recentWorkspaces } = useShell()
  const [query, setQuery] = useState("")

  const org = getOrg(currentOrg)
  const active = org?.workspaces.find((w) => w.slug === currentWs)

  // Recents for the current org, excluding the active workspace.
  const recents = useMemo(() => {
    if (!org) return []
    return recentWorkspaces
      .filter((r) => r.org === currentOrg && r.ws !== currentWs)
      .map((r) => getWorkspace(r.org, r.ws))
      .filter((w): w is NonNullable<typeof w> => Boolean(w))
      .slice(0, 3)
  }, [recentWorkspaces, org, currentOrg, currentWs])

  const filtered = useMemo(() => {
    if (!org) return []
    const q = query.trim().toLowerCase()
    if (!q) return org.workspaces
    return org.workspaces.filter(
      (w) =>
        w.name.toLowerCase().includes(q) || w.description.toLowerCase().includes(q),
    )
  }, [org, query])

  if (!org) return null

  function switchTo(wsSlug: string) {
    setLastWorkspace({ org: currentOrg, ws: wsSlug })
    router.push(buildWorkspaceSwitchPath(pathname, currentOrg, wsSlug))
  }

  return (
    <DropdownMenu onOpenChange={(open) => !open && setQuery("")}>
      <DropdownMenuTrigger
        aria-haspopup="menu"
        className={cn(
          "glass flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1.5 text-sm font-medium",
          "outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <span className="max-w-[120px] truncate">{active?.name ?? "Select workspace"}</span>
        <ChevronsUpDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 p-0">
        {/* Search */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Search workspaces…"
            aria-label="Search workspaces"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div className="max-h-[320px] overflow-y-auto py-1">
          {/* Recents */}
          {!query && recents.length > 0 && (
            <>
              <DropdownMenuLabel className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                <Clock className="size-3" aria-hidden="true" />
                Recent
              </DropdownMenuLabel>
              {recents.map((ws) => (
                <DropdownMenuItem
                  key={`recent-${ws.slug}`}
                  onSelect={() => switchTo(ws.slug)}
                  className="gap-2"
                >
                  <span className="flex-1 truncate text-sm">{ws.name}</span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
            </>
          )}

          {/* All workspaces in org */}
          <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {query ? "Results" : `Workspaces in ${org.name}`}
          </DropdownMenuLabel>
          {filtered.length === 0 ? (
            <p className="px-3 py-4 text-center text-sm text-muted-foreground">
              No workspaces match “{query}”.
            </p>
          ) : (
            filtered.map((ws) => (
              <DropdownMenuItem
                key={ws.slug}
                disabled={ws.slug === active?.slug}
                onSelect={() => switchTo(ws.slug)}
                className="flex items-start gap-2"
              >
                <div className="flex-1">
                  <p className="truncate text-sm">{ws.name}</p>
                  <p className="truncate text-xs text-muted-foreground">{ws.description}</p>
                </div>
                {ws.slug === active?.slug && (
                  <Check className="mt-0.5 size-4 text-brand" aria-hidden="true" />
                )}
              </DropdownMenuItem>
            ))
          )}
        </div>

        <DropdownMenuSeparator className="my-0" />
        <div className="py-1">
          <DropdownMenuItem className="gap-2 text-muted-foreground">
            <Plus className="size-4" aria-hidden="true" />
            New workspace
          </DropdownMenuItem>
          <DropdownMenuItem
            className="gap-2 text-muted-foreground"
            onSelect={() => router.push(`/${org.slug}/workspaces`)}
          >
            <Settings2 className="size-4" aria-hidden="true" />
            Manage workspaces
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
