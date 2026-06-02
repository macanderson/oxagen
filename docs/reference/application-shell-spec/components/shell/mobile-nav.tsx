"use client"

import type { ScopeContext, ShellMode } from "@/lib/scope"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Sidebar } from "./sidebar"
import { OrgSwitcher } from "./org-switcher"
import { WorkspaceSwitcher } from "./workspace-switcher"
import { useShell } from "./shell-context"

export function MobileNav({
  mode,
  scope,
}: {
  mode: Exclude<ShellMode, "pre-shell">
  scope: ScopeContext
}) {
  const { mobileNavOpen, setMobileNavOpen } = useShell()

  return (
    <Sheet open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
      <SheetContent side="left" className="w-72 p-0">
        <SheetHeader className="border-b border-border p-4 text-left">
          <SheetTitle className="text-sm">Navigation</SheetTitle>
          {mode !== "account" && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <OrgSwitcher currentOrg={scope.org} />
              {mode === "workspace" && scope.org && (
                <WorkspaceSwitcher currentOrg={scope.org} currentWs={scope.ws} />
              )}
            </div>
          )}
        </SheetHeader>
        <div className="h-[calc(100dvh-5rem)]">
          <Sidebar mode={mode} scope={scope} onNavigate={() => setMobileNavOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
