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
 *
 * The org/workspace pickers and balance pill resolve from `navDataPromise`
 * inside <Suspense> slots, so the frame + page children paint immediately while
 * the heavy nav data streams in (it is NOT awaited by the org layout).
 */

import { Suspense, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { PanelLeft } from "lucide-react";
import { Sidebar } from "./sidebar";
import { resolveSidebarCtx } from "@/lib/sidebar";
import { AskBar } from "@/components/shell/ask/ask-bar";
import { NotificationsBell } from "./notifications-bell";
import { SupportMenu } from "./support-menu";
import {
  OrgSwitcherSlot,
  OrgSwitcherFallback,
  WorkspaceSwitcherSlot,
  BalanceSlot,
  type ShellNavData,
} from "./shell-nav-slots";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "@/components/ui/tooltip";
import { useSidebar } from "./sidebar-context";
import type { ResolvedOrg, ResolvedWorkspace } from "@/lib/resolve-org";
import type { SessionUser } from "./user-switcher";
import type { ScopeContext } from "@/lib/scope";
import type { NewWorkspaceAction } from "@/components/workspace/new-workspace-form";

import type { PlanTier } from "@oxagen/oxagen/types";

export interface ShellFrameProps {
  org: ResolvedOrg;
  workspace?: ResolvedWorkspace;
  /** Heavy nav data (org list, workspace list, balance) streamed off the layout's critical path. */
  navDataPromise: Promise<ShellNavData>;
  /** May be undefined during a transient post-signup render; guarded in UserSwitcher. */
  user: SessionUser | undefined;
  /** Org subscription tier — gates enterprise-only nav items (e.g. Access). */
  planTier?: PlanTier;
  /** Bound server action for inline workspace creation dialog. */
  createWorkspaceAction?: NewWorkspaceAction;
  children: ReactNode;
}

export function ShellFrame({
  org,
  workspace,
  navDataPromise,
  user,
  planTier,
  createWorkspaceAction,
  children,
}: ShellFrameProps) {
  const { toggle } = useSidebar();
  const pathname = usePathname();

  // The shell mounts at the [orgSlug] layout, which can't see the
  // [workspaceSlug] route param — so `workspace` is undefined on workspace
  // routes. Recover the active workspace slug from the URL (same parse the
  // sidebar uses) so the AskBar scopes correctly and the workspace picker shows.
  const ctx: ScopeContext = resolveSidebarCtx(pathname, {
    orgSlug: org.slug,
    workspaceSlug: workspace?.slug,
  });

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-background md:gap-2 md:p-2">
      {/* Skip-to-main link — visually hidden until focused (WCAG 2.4.1). */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[10000] focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Skip to main content
      </a>

      {/* Floating, collapsible sidebar (desktop). Mobile uses MobileBottomBar. */}
      <Sidebar ctx={ctx} user={user} planTier={planTier} />

      {/* Inset content panel — the majority-width right side. */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden border-app-topbar-border bg-app-panel-bg text-app-panel-fg md:rounded-xl md:border md:shadow-sm">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-app-topbar-border bg-app-topbar-bg px-3 text-app-topbar-fg">
          {/* Desktop: sidebar collapse toggle. Mobile nav lives in the
              bottom bar (MobileBottomBar), so no header trigger here. */}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="hidden md:inline-flex"
                  aria-label="Toggle sidebar"
                  onClick={toggle}
                />
              }
            >
              <PanelLeft className="size-4" />
            </TooltipTrigger>
            <TooltipPopup>Toggle sidebar</TooltipPopup>
          </Tooltip>

          {/* Top-left: org / workspace pickers (org ▾ / workspace ▾). Stream in
              from navDataPromise so the header paints without waiting on the
              org-list join. */}
          <div className="flex min-w-0 shrink items-center gap-2">
            <Suspense fallback={<OrgSwitcherFallback />}>
              <OrgSwitcherSlot org={org} navDataPromise={navDataPromise} />
            </Suspense>
            <Suspense fallback={null}>
              <WorkspaceSwitcherSlot
                org={org}
                workspace={workspace}
                navDataPromise={navDataPromise}
                createWorkspaceAction={createWorkspaceAction}
              />
            </Suspense>
          </div>

          {/* Ask bar — fills the remaining header width. */}
          <div className="hidden min-w-0 flex-1 sm:block">
            <div className="mx-auto max-w-xl">
              <AskBar ctx={ctx} />
            </div>
          </div>

          {/* Right cluster: balance · support · notifications. */}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Suspense fallback={null}>
              <BalanceSlot orgSlug={org.slug} navDataPromise={navDataPromise} />
            </Suspense>
            <SupportMenu orgSlug={ctx.orgSlug} workspaceSlug={ctx.workspaceSlug} />
            <NotificationsBell />
          </div>
        </header>

        <main id="main-content" className="flex-1 overflow-y-auto p-4 max-md:pb-[calc(var(--bottom-bar-h)+var(--bottom-bar-gap)+env(safe-area-inset-bottom))] md:p-6 md:pb-6">
          {children}
        </main>
      </div>
    </div>
  );
}
