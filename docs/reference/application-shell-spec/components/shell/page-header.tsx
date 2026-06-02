"use client"

import Link from "next/link"
import { ChevronRight, MoreHorizontal, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useShell } from "./shell-context"

export type Crumb = { label: string; href: string }

export function PageHeader({
  title,
  description,
  crumbs,
  askEntity,
  actions,
}: {
  title: string
  description?: string
  crumbs?: Crumb[]
  askEntity?: string
  actions?: React.ReactNode
}) {
  const { openAsk } = useShell()

  return (
    <div className="border-b border-border px-4 pb-3 pt-4 sm:px-6">
      {crumbs && crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-1.5">
          <ol className="flex items-center gap-1 text-xs text-muted-foreground">
            {crumbs.map((c, i) => (
              <li key={c.href} className="flex items-center gap-1">
                {i > 0 && <ChevronRight className="size-3" aria-hidden="true" />}
                <Link
                  href={c.href}
                  className="rounded capitalize hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {c.label}
                </Link>
              </li>
            ))}
          </ol>
        </nav>
      )}

      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
          {description && (
            <p className="mt-0.5 text-pretty text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {actions}
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => openAsk(askEntity ?? title)}
          >
            <Sparkles className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">Ask about this</span>
          </Button>
          <Button variant="ghost" size="icon" className="size-8" aria-label="More actions">
            <MoreHorizontal className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}
