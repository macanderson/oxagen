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
import { AgentBottomBar } from "@/components/agent-panel/agent-bottom-bar";
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
import { HeroBackdrop } from "@/components/brand/hero-backdrop";
import { Tooltip, TooltipTrigger, TooltipPopup } from "@/components/ui/tooltip";
import { useSidebar } from "./sidebar-context";
import { cn } from "@/lib/utils";
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
  /**
   * Whether to render the persistent agent bottom bar. Defaults to true.
   * The bar consumes `useAgentPanelStore`, so it must only render where an
   * `AgentPanelStoreProvider` (and the agent panel itself) is mounted. The
   * user-scoped account section is deliberately workspace-less and does not
   * mount the agent panel, so it opts out via `agentBar={false}`.
   */
  agentBar?: boolean;
  children: ReactNode;
}

export function ShellFrame({
  org,
  workspace,
  navDataPromise,
  user,
  planTier,
  createWorkspaceAction,
  agentBar = true,
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

  // The conversation page (/{org}/{workspace}/ask) treats the transcript as
  // the page's primary real estate, so the shell's standard content padding
  // shrinks to a slim gutter there — the conversation reaches (nearly) to the
  // panel edges on every side. All other routes keep the roomier default.
  const isConversationRoute = /^\/[^/]+\/[^/]+\/ask(?:\/|$)/.test(pathname);

  return (
    <div className="relative isolate flex h-dvh w-full overflow-hidden bg-background md:gap-2 md:p-2">
      {/* Ember hero backdrop — the same brand lattice as the docs/auth surfaces,
          dialled down. Mostly hidden behind the floating sidebar + content
          panels; it glows through the gap/padding sliver around them. */}
      <HeroBackdrop intensity="ambient" />

      {/* Skip-to-main link — visually hidden until focused (WCAG 2.4.1). */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[10000] focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring"
      >
        Skip to main content
      </a>

      {/* Floating, collapsible sidebar (desktop). Mobile uses MobileBottomBar. */}
      <Sidebar ctx={ctx} user={user} planTier={planTier} />

      {/* Inset content panel — the majority-width right side. The panel fill stays
          opaque for guaranteed text contrast; a dedicated `-z-10` grid layer below
          paints the login's crisp, top-fading "chart paper" texture ABOVE the fill
          but BELOW content (the mask must live on its own layer, never on the panel
          itself, or it would fade the whole panel + its content). The ember hero
          backdrop glows through the gap/padding sliver around the panel. */}
      <div className="relative isolate flex min-w-0 flex-1 flex-col overflow-hidden border-app-topbar-border bg-app-panel-bg text-app-panel-fg md:rounded-xl md:border md:shadow-sm">
        <div
          aria-hidden="true"
          className="ox-panel-grid pointer-events-none absolute inset-0 -z-10"
        />
        <header
          data-shell-topbar
          className="flex h-14 shrink-0 items-center gap-2 border-b border-app-topbar-border bg-app-topbar-bg px-3 text-app-topbar-fg"
        >
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
            <SupportMenu
              orgSlug={ctx.orgSlug}
              workspaceSlug={ctx.workspaceSlug}
            />
            <NotificationsBell />
          </div>
        </header>

        <main
          id="main-content"
          className={cn(
            "flex-1 overflow-y-auto max-md:pb-[calc(var(--bottom-bar-h)+var(--bottom-bar-gap)+env(safe-area-inset-bottom))]",
            isConversationRoute ? "p-2 md:p-3" : "p-4 md:p-6 md:pb-6",
          )}
        >
          {children}
        </main>

        {/* Agent bottom bar — persistent across all pages (desktop only).
            Suppressed in workspace-less sections (e.g. /account) that don't
            mount the agent panel / AgentPanelStoreProvider. */}
        {agentBar && (
          <div className="hidden md:block">
            <AgentBottomBar />
          </div>
        )}
      </div>
    </div>
  );
}
