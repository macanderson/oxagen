"use client"

import Link from "next/link"
import { Menu, Sparkles } from "lucide-react"
import type { ScopeContext, ShellMode } from "@/lib/scope"
import { Button } from "@/components/ui/button"
import { OrgSwitcher } from "./org-switcher"
import { WorkspaceSwitcher } from "./workspace-switcher"
import { AskBar } from "./ask-bar"
import { NotificationsBell } from "./notifications-bell"
import { AvatarMenu } from "./avatar-menu"
import { useShell } from "./shell-context"
import { OxagenLogomark, OxagenWordmark } from "./oxagen-logo"

type TopbarProps = {
  mode: Exclude<ShellMode, "pre-shell">
  scope: ScopeContext
}

function BrandMark() {
  const { lastWorkspace } = useShell()
  const href = lastWorkspace ? `/${lastWorkspace.org}/${lastWorkspace.ws}/ask` : "/"
  return (
    <Link
      href={href}
      aria-label="Oxagen — home"
      className="group flex items-center gap-2.5 rounded-md outline-none transition-transform duration-200 hover:scale-[1.02] focus-visible:ring-2 focus-visible:ring-ring"
    >
      <OxagenLogomark className="size-7 text-foreground transition-colors" />
      <OxagenWordmark className="hidden h-[14px] w-auto text-foreground transition-colors sm:block" />
    </Link>
  )
}

export function Topbar({ mode, scope }: TopbarProps) {
  const { setMobileNavOpen, openAsk } = useShell()

  return (
    <header className="glass sticky top-0 z-30 flex h-14 items-center gap-2 border-b px-3 sm:gap-3 sm:px-4">
      {/* Mobile hamburger */}
      <Button
        variant="ghost"
        size="icon"
        className="size-9 lg:hidden"
        aria-label="Open navigation"
        onClick={() => setMobileNavOpen(true)}
      >
        <Menu className="size-5" />
      </Button>

      <BrandMark />

      {/* Switcher chips — breadcrumb style. Hidden in account mode. */}
      {mode !== "account" && (
        <div className="hidden items-center gap-2 sm:flex">
          <span className="text-muted-foreground">/</span>
          <OrgSwitcher currentOrg={scope.org} />
          {mode === "workspace" && scope.org && (
            <>
              <span className="text-muted-foreground">/</span>
              <WorkspaceSwitcher currentOrg={scope.org} currentWs={scope.ws} />
            </>
          )}
        </div>
      )}

      {/* Ask bar — center, grows. Collapses to icon under md. */}
      <div className="ml-auto flex flex-1 justify-center px-2 max-md:hidden">
        <AskBar mode={mode} scope={scope} />
      </div>

      <Button
        variant="ghost"
        size="icon"
        className="ml-auto size-9 md:hidden"
        aria-label="Open Ask"
        onClick={() => openAsk()}
      >
        <Sparkles className="size-[18px]" />
      </Button>

      <div className="flex items-center gap-1">
        <NotificationsBell />
        <AvatarMenu />
      </div>
    </header>
  )
}
