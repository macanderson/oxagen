"use client"

import { useState } from "react"
import { Plus } from "lucide-react"
import { motion } from "framer-motion"
import { cn } from "@/lib/utils"
import type { DestinationConfig } from "@/lib/destinations"
import { Button } from "@/components/ui/button"
import { PageHeader, type Crumb } from "./page-header"
import { PageTabs, TabPanel } from "./page-tabs"

function TabStub({
  destLabel,
  tabLabel,
  chips,
}: {
  destLabel: string
  tabLabel: string
  chips?: string[]
}) {
  const [activeChip, setActiveChip] = useState(chips?.[0])

  const rows = Array.from({ length: 5 }).map((_, i) => ({
    id: i,
    name: `${tabLabel} item ${i + 1}`,
    meta: activeChip ? `${activeChip} · updated ${i + 1}d ago` : `updated ${i + 1}d ago`,
  }))

  return (
    <div className="p-4 sm:p-6">
      {chips && chips.length > 0 && (
        <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter">
          {chips.map((chip) => (
            <button
              key={chip}
              onClick={() => setActiveChip(chip)}
              aria-pressed={chip === activeChip}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                chip === activeChip
                  ? "border-brand bg-brand/10 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {chip}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-muted-foreground">
          {destLabel} / {tabLabel}
          {activeChip ? ` · ${activeChip}` : ""}
        </h2>
        <Button size="sm" variant="outline" className="gap-1.5">
          <Plus className="size-4" aria-hidden="true" />
          New
        </Button>
      </div>

      <div className="mt-3 overflow-hidden rounded-xl border border-border glass-subtle">
        <ul className="divide-y divide-border/50">
          {rows.map((r, i) => (
            <motion.li
              key={r.id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.05, duration: 0.25 }}
              className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40"
            >
              <span className="grid size-9 place-items-center rounded-lg bg-muted/60 text-xs font-semibold text-muted-foreground">
                {r.name.charAt(0)}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{r.name}</p>
                <p className="truncate text-xs text-muted-foreground">{r.meta}</p>
              </div>
              <span className="rounded-full border border-border/60 bg-background/50 px-2.5 py-0.5 text-[11px] text-muted-foreground">
                Active
              </span>
            </motion.li>
          ))}
        </ul>
      </div>

      <p className="mt-4 text-xs text-muted-foreground">
        This is a mock {tabLabel.toLowerCase()} surface. In production this tab renders real data,
        URL-addressable at this route.
      </p>
    </div>
  )
}

export function DestinationPage({
  dest,
  basePath,
  activeSlug,
  crumbs,
}: {
  dest: DestinationConfig
  basePath: string
  activeSlug: string
  crumbs: Crumb[]
}) {
  const activeTab = dest.tabs.find((t) => t.slug === activeSlug) ?? dest.tabs[0]

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={dest.label}
        description={dest.description}
        crumbs={crumbs}
        askEntity={`${dest.label} · ${activeTab.label}`}
      />
      <PageTabs basePath={basePath} tabs={dest.tabs} activeSlug={activeSlug} />
      <div role="tabpanel" className="flex-1">
        <TabPanel tabKey={activeSlug}>
          <TabStub destLabel={dest.label} tabLabel={activeTab.label} chips={activeTab.chips} />
        </TabPanel>
      </div>
    </div>
  )
}
