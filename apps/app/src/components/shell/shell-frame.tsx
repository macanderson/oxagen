"use client";
/**
 * ShellFrame — the floating left-nav layout.
 *
 * Stock coss ui surfaces, no glass:
 *   - A muted page canvas.
 *   - A floating, collapsible Sidebar card on the left (brand + nav + account).
 *   - An inset, rounded content panel on the right (the majority-width side)
 *     whose header carries the sidebar toggle, the Ask bar, and — pinned right —
 *     the org / workspace pickers + notifications.
 *
 * Client component: it consumes the sidebar collapse state and renders the
 * client islands (AskBar, switchers, bell). The page content arrives as
 * `children` (server-rendered) and is just slotted into <main>.
 */

import type { ReactNode } from "react";
import { PanelLeft } from "lucide-react";
import { Sidebar } from "./sidebar";
import { MobileNav } from "./mobile-nav";
import { AskBar } from "@/components/shell/ask/ask-bar";
import { NotificationsBell } from "./notifications-bell";
import { OrgSwitcher } from "@/components/org/org-switcher";
import { WorkspaceSwitcher } from "@/components/workspace/workspace-switcher";
import { Button } from "@/components/ui/button";
import { useSidebar } from "./sidebar-context";
import type { ResolvedOrg, ResolvedWorkspace } from "@/lib/resolve-org";
import type { SessionUser } from "./user-switcher";
import type { ScopeContext } from "@/lib/scope";

export interface ShellFrameProps {
  org: ResolvedOrg;
  workspace?: ResolvedWorkspace;
  availableOrgs: { publicId: string; slug: string; name: string }[];
  availableWorkspaces?: { publicId: string; slug: string; name: string }[];
  /** May be undefined during a transient post-signup render; guarded in UserSwitcher. */
  user: SessionUser | undefined;
  children: ReactNode;
}

export function ShellFrame({
  org,
  workspace,
  availableOrgs,
  availableWorkspaces,
  user,
  children,
}: ShellFrameProps) {
  const { toggle } = useSidebar();
  const ctx: ScopeContext = { orgSlug: org.slug, workspaceSlug: workspace?.slug };

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-muted/40 md:gap-2 md:p-2">
      {/* Floating, collapsible sidebar (desktop). Mobile uses MobileNav + bar. */}
      <Sidebar ctx={ctx} user={user} />

      {/* Inset content panel — the majority-width right side. */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-border bg-background md:rounded-xl md:border md:shadow-sm">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
          {/* Desktop: collapse toggle. Mobile: drawer trigger. */}
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:inline-flex"
            aria-label="Toggle sidebar"
            onClick={toggle}
          >
            <PanelLeft className="size-4" />
          </Button>
          <div className="md:hidden">
            <MobileNav
              ctx={ctx}
              org={org}
              workspace={workspace}
              availableOrgs={availableOrgs}
              availableWorkspaces={availableWorkspaces}
              user={user}
            />
          </div>

          {/* Ask bar — fills the remaining header width. */}
          <div className="hidden min-w-0 flex-1 sm:block">
            <div className="max-w-xl">
              <AskBar ctx={ctx} />
            </div>
          </div>

          {/* Right cluster: org / workspace pickers + notifications. */}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <OrgSwitcher current={org} organizations={availableOrgs} />
            {workspace ? (
              <WorkspaceSwitcher
                orgSlug={org.slug}
                current={workspace}
                workspaces={availableWorkspaces ?? []}
              />
            ) : null}
            <NotificationsBell />
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-4 pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:p-6 md:pb-6">
          {children}
        </main>
      </div>
    </div>
  );
}
