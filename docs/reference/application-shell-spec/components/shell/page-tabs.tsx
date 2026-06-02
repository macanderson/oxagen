"use client"

import { useRef, useEffect, useState, useId } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { motion, AnimatePresence } from "framer-motion"
import { cn } from "@/lib/utils"
import type { TabConfig } from "@/lib/destinations"
import { Badge } from "@/components/ui/badge"

export function PageTabs({
  basePath,
  tabs,
  activeSlug,
}: {
  basePath: string
  tabs: TabConfig[]
  activeSlug: string
}) {
  const router = useRouter()
  const listRef = useRef<HTMLDivElement>(null)
  const [indicatorStyle, setIndicatorStyle] = useState({ left: 0, width: 0 })
  const layoutId = useId()

  // Update indicator position when active tab changes
  useEffect(() => {
    const container = listRef.current
    if (!container) return

    const activeTab = container.querySelector<HTMLAnchorElement>(
      `[data-slug="${activeSlug}"]`
    )
    if (!activeTab) return

    const containerRect = container.getBoundingClientRect()
    const tabRect = activeTab.getBoundingClientRect()

    setIndicatorStyle({
      left: tabRect.left - containerRect.left + container.scrollLeft,
      width: tabRect.width,
    })
  }, [activeSlug])

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return
    e.preventDefault()
    const idx = tabs.findIndex((t) => t.slug === activeSlug)
    const next =
      e.key === "ArrowRight"
        ? Math.min(idx + 1, tabs.length - 1)
        : Math.max(idx - 1, 0)
    router.push(`${basePath}/${tabs[next].slug}`)
  }

  return (
    <div className="relative border-b border-border/60 bg-background/50 backdrop-blur-sm">
      <div
        ref={listRef}
        role="tablist"
        aria-label="Sub-sections"
        onKeyDown={onKeyDown}
        className="tabs-edge-fade no-scrollbar relative flex gap-1 overflow-x-auto px-4 sm:px-6"
      >
        {/* Animated sliding indicator */}
        <motion.div
          layoutId={`tab-indicator-${layoutId}`}
          className="brand-gradient absolute bottom-0 h-0.5 rounded-full"
          initial={false}
          animate={{
            left: indicatorStyle.left,
            width: indicatorStyle.width,
          }}
          transition={{
            type: "spring",
            stiffness: 400,
            damping: 30,
          }}
        />

        {tabs.map((tab) => {
          const active = tab.slug === activeSlug
          return (
            <Link
              key={tab.slug}
              href={`${basePath}/${tab.slug}`}
              role="tab"
              data-slug={tab.slug}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={cn(
                "relative flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-3 text-sm font-medium transition-colors duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <motion.span
                initial={{ opacity: 0.8 }}
                animate={{ opacity: active ? 1 : 0.8 }}
                transition={{ duration: 0.2 }}
              >
                {tab.label}
              </motion.span>
              {tab.badge != null && (
                <Badge
                  variant={active ? "default" : "secondary"}
                  className={cn(
                    "h-5 min-w-5 justify-center px-1.5 text-[11px] tabular-nums transition-colors duration-200",
                    active && "bg-brand text-brand-foreground",
                  )}
                >
                  {tab.badge}
                </Badge>
              )}
            </Link>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Wrapper for tab panel content with enter/exit animations.
 * Use this in page components to animate content transitions.
 */
export function TabPanel({
  children,
  tabKey,
}: {
  children: React.ReactNode
  tabKey: string
}) {
  return (
    <AnimatePresence mode="wait">
      <motion.div
        key={tabKey}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{
          duration: 0.2,
          ease: [0.4, 0, 0.2, 1],
        }}
      >
        {children}
      </motion.div>
    </AnimatePresence>
  )
}
