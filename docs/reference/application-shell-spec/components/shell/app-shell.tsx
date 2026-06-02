"use client"

import { useEffect } from "react"
import { usePathname } from "next/navigation"
import { resolveScope } from "@/lib/scope"
import { Topbar } from "./topbar"
import { Sidebar } from "./sidebar"
import { MobileNav } from "./mobile-nav"
import { AskDrawer } from "./ask-drawer"
import { useShell } from "./shell-context"

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const { mode, scope } = resolveScope(pathname)
  const { setLastWorkspace, pushRecentWorkspace, setReturnPath } = useShell()

  // Remember the last-viewed workspace + recents (spec §10).
  useEffect(() => {
    if (mode === "workspace" && scope.org && scope.ws) {
      setLastWorkspace({ org: scope.org, ws: scope.ws })
      pushRecentWorkspace({ org: scope.org, ws: scope.ws })
    }
  }, [mode, scope.org, scope.ws, setLastWorkspace, pushRecentWorkspace])

  // Track where to return when the user leaves Account mode.
  useEffect(() => {
    if (mode !== "account") {
      setReturnPath(pathname)
    }
  }, [mode, pathname, setReturnPath])

  if (mode === "pre-shell") {
    return <>{children}</>
  }

  return (
    <div className="app-bg flex min-h-dvh flex-col">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-3 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:text-sm focus:shadow focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>

      <Topbar mode={mode} scope={scope} />

      <div className="flex flex-1">
        {/* Desktop full sidebar (lg+) */}
        <aside className="hidden w-60 shrink-0 border-r border-border/60 lg:block">
          <div className="sticky top-14 h-[calc(100dvh-3.5rem)]">
            <Sidebar mode={mode} scope={scope} />
          </div>
        </aside>

        {/* Tablet icon rail (md to lg) */}
        <aside className="hidden w-16 shrink-0 border-r border-border/60 md:block lg:hidden">
          <div className="sticky top-14 h-[calc(100dvh-3.5rem)]">
            <Sidebar mode={mode} scope={scope} collapsed />
          </div>
        </aside>

        <main id="main-content" className="min-w-0 flex-1">
          {children}
        </main>
      </div>

      <MobileNav mode={mode} scope={scope} />
      <AskDrawer />
    </div>
  )
}
