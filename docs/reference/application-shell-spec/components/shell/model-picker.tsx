"use client"

import { useMemo, useState } from "react"
import { Check, ChevronRight, ChevronsUpDown, Search } from "lucide-react"
import { cn } from "@/lib/utils"
import {
  capabilityLabel,
  formatReleaseDate,
  gatewayModels,
  getModel,
  oxagenTiers,
  vendorLabels,
  type OxagenTier,
} from "@/lib/models"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ScrollArea } from "@/components/ui/scroll-area"
import { VendorLogo, VendorTile } from "./vendor-logos"

export type ModelSelection = {
  label: string
  modelId: string
  isTier: boolean
  tierId?: OxagenTier["id"]
}

export const defaultSelection: ModelSelection = {
  label: oxagenTiers[1].name,
  modelId: oxagenTiers[1].modelId,
  isTier: true,
  tierId: oxagenTiers[1].id,
}

function tierToSelection(t: OxagenTier): ModelSelection {
  return { label: t.name, modelId: t.modelId, isTier: true, tierId: t.id }
}

export function ModelPicker({
  value,
  onChange,
}: {
  value: ModelSelection
  onChange: (s: ModelSelection) => void
}) {
  const [open, setOpen] = useState(false)
  const [showOther, setShowOther] = useState(false)
  const [query, setQuery] = useState("")

  const triggerVendor = getModel(value.modelId)?.vendor ?? "anthropic"

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return gatewayModels
    return gatewayModels.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        vendorLabels[m.vendor].toLowerCase().includes(q),
    )
  }, [query])

  function pickModel(id: string) {
    const m = getModel(id)
    if (!m) return
    onChange({ label: m.name, modelId: m.id, isTier: false })
    setOpen(false)
  }

  function pickTier(t: OxagenTier) {
    onChange(tierToSelection(t))
    setOpen(false)
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) {
          setShowOther(false)
          setQuery("")
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-1.5 px-2 text-xs font-medium"
          aria-label={`Model: ${value.label}`}
        >
          <span className="grid size-5 place-items-center rounded border border-border bg-muted/50">
            <VendorLogo vendor={triggerVendor} className="size-3" />
          </span>
          <span className="max-w-[140px] truncate">{value.label}</span>
          <ChevronsUpDown className="size-3 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={8}
        className={cn("p-0", showOther ? "w-[42rem] max-w-[92vw]" : "w-80")}
      >
        <div className="flex">
          {/* Left: branded tiers */}
          <div className="w-80 shrink-0 p-1.5">
            <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">Oxagen models</p>
            <div className="space-y-0.5">
              {oxagenTiers.map((t) => {
                const m = getModel(t.modelId)
                const selected = value.isTier && value.tierId === t.id
                return (
                  <button
                    key={t.id}
                    onClick={() => pickTier(t)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors",
                      selected ? "bg-muted" : "hover:bg-muted/60",
                    )}
                  >
                    <VendorTile vendor="anthropic" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-medium">{t.name}</span>
                        {selected && <Check className="size-3.5 text-brand" />}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {t.blurb}
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[10px] text-muted-foreground/80">
                        {t.modelId}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>

            <div className="my-1.5 h-px bg-border" />

            <button
              onClick={() => setShowOther((s) => !s)}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors",
                showOther ? "bg-muted" : "hover:bg-muted/60",
              )}
              aria-expanded={showOther}
            >
              <Search className="size-4 text-muted-foreground" />
              <span className="flex-1 font-medium">Other models…</span>
              <ChevronRight
                className={cn(
                  "size-4 text-muted-foreground transition-transform",
                  showOther && "rotate-90",
                )}
              />
            </button>
            {!value.isTier && (
              <p className="px-2 pt-1 text-xs text-muted-foreground">
                Using{" "}
                <span className="font-medium text-foreground">{value.label}</span> from the gateway.
              </p>
            )}
          </div>

          {/* Right: full gateway catalog */}
          {showOther && (
            <div className="flex min-w-0 flex-1 flex-col border-l border-border">
              <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                <Search className="size-4 shrink-0 text-muted-foreground" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search all gateway models…"
                  aria-label="Search gateway models"
                  className="w-full bg-transparent text-sm focus:outline-none"
                />
              </div>
              <ScrollArea className="h-80">
                <div className="space-y-0.5 p-1.5">
                  {filtered.length === 0 && (
                    <p className="px-2 py-6 text-center text-sm text-muted-foreground">
                      No models match “{query}”.
                    </p>
                  )}
                  {filtered.map((m) => {
                    const selected = !value.isTier && value.modelId === m.id
                    return (
                      <button
                        key={m.id}
                        onClick={() => pickModel(m.id)}
                        className={cn(
                          "flex w-full items-start gap-2.5 rounded-md px-2 py-2 text-left transition-colors",
                          selected ? "bg-muted" : "hover:bg-muted/60",
                        )}
                      >
                        <VendorTile vendor={m.vendor} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-medium">{m.name}</span>
                            {selected && <Check className="size-3.5 shrink-0 text-brand" />}
                          </span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {vendorLabels[m.vendor]} · {formatReleaseDate(m.released)}
                            {m.context ? ` · ${m.context}` : ""}
                          </span>
                          <span className="mt-1 flex flex-wrap gap-1">
                            {m.capabilities.map((c) => (
                              <span
                                key={c}
                                className="rounded border border-border bg-background px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground"
                              >
                                {capabilityLabel(c)}
                              </span>
                            ))}
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              </ScrollArea>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
