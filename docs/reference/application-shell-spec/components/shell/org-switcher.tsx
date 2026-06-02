"use client"

import { useMemo, useState } from "react"
import { usePathname, useRouter } from "next/navigation"
import { Check, ChevronsUpDown, Plus, Search } from "lucide-react"
import { cn } from "@/lib/utils"
import { buildOrgSwitchPath } from "@/lib/scope"
import { orgs } from "@/lib/mock-data"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export function OrgSwitcher({ currentOrg }: { currentOrg?: string }) {
  const router = useRouter()
  const pathname = usePathname()
  const [query, setQuery] = useState("")
  const active = orgs.find((o) => o.slug === currentOrg) ?? orgs[0]

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return orgs
    return orgs.filter(
      (o) =>
        o.name.toLowerCase().includes(q) || o.plan.toLowerCase().includes(q),
    )
  }, [query])

  return (
    <DropdownMenu onOpenChange={(open) => !open && setQuery("")}>
      <DropdownMenuTrigger
        aria-haspopup="menu"
        className={cn(
          "glass flex items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1.5 text-sm font-medium",
          "outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        <span className="grid size-5 place-items-center rounded bg-brand text-[11px] font-semibold text-brand-foreground">
          {active.name.charAt(0)}
        </span>
        <span className="max-w-[120px] truncate">{active.name}</span>
        <ChevronsUpDown className="size-3.5 text-muted-foreground" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 p-0">
        {/* Search */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Search organizations…"
            aria-label="Search organizations"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>

        <div className="max-h-[320px] overflow-y-auto py-1">
          <DropdownMenuLabel className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {query ? "Results" : "Organizations"}
          </DropdownMenuLabel>
          {filtered.length === 0 ? (
            <p className="px-3 py-4 text-center text-sm text-muted-foreground">
              No organizations match “{query}”.
            </p>
          ) : (
            filtered.map((org) => (
              <DropdownMenuItem
                key={org.slug}
                disabled={org.slug === active.slug}
                onSelect={() => router.push(buildOrgSwitchPath(pathname, org.slug))}
                className="flex items-center gap-2"
              >
                <span className="grid size-5 place-items-center rounded bg-muted text-[11px] font-semibold">
                  {org.name.charAt(0)}
                </span>
                <span className="flex-1 truncate">{org.name}</span>
                <span className="text-xs text-muted-foreground">{org.plan}</span>
                {org.slug === active.slug && (
                  <Check className="size-4 text-brand" aria-hidden="true" />
                )}
              </DropdownMenuItem>
            ))
          )}
        </div>

        <DropdownMenuSeparator className="my-0" />
        <div className="py-1">
          <DropdownMenuItem className="gap-2 text-muted-foreground">
            <Plus className="size-4" aria-hidden="true" />
            New organization
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
