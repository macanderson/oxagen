/**
 * AppShell — the top-level layout chrome.
 *
 * Renders:
 *   Desktop: fixed-width Sidebar (left) + flex column (Topbar sticky + <main> scrollable)
 *   Mobile:  Topbar (with hamburger) + <main> + MobileBottomBar (fixed bottom)
 *
 * The shell is a server component. The Sidebar and MobileBottomBar are client
 * components (they read usePathname for active state). The Topbar is a server
 * component that renders client AskBar/NotificationsBell/AvatarMenu as islands.
 *
 * PageContextProvider, AskDrawer, and CommandMenu are mounted once in the
 * route layout (not here) so they persist across page navigations within
 * the same layout boundary.
 */

import type { ReactNode } from "react";
import { Sidebar, MobileBottomBar } from "./sidebar";
import { Topbar } from "./topbar";
import type { ResolvedOrg, ResolvedWorkspace } from "@/lib/resolve-org";
import type { SessionUser } from "./user-switcher";

export interface AppShellProps {
  org: ResolvedOrg;
  workspace?: ResolvedWorkspace;
  availableOrgs: { publicId: string; slug: string; name: string }[];
  availableWorkspaces?: { publicId: string; slug: string; name: string }[];
  user: SessionUser;
  children: ReactNode;
}

export function AppShell({
  org,
  workspace,
  availableOrgs,
  availableWorkspaces,
  user,
  children,
}: AppShellProps) {
  const ctx = { orgSlug: org.slug, workspaceSlug: workspace?.slug };

  return (
    <div className="app-bg flex h-dvh w-full overflow-hidden">
      {/* Desktop sidebar — hidden on mobile */}
      <Sidebar ctx={ctx} user={user} />

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          org={org}
          workspace={workspace}
          availableOrgs={availableOrgs}
          availableWorkspaces={availableWorkspaces}
          user={user}
        />
        {/*
          On mobile the bottom bar is fixed/overlapping, so we add bottom
          padding equal to the bar height (~56px) only at < md so content
          doesn't hide behind it.
        */}
        <main
          className="flex-1 overflow-y-auto p-4 pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:p-6 md:pb-6"
        >
          {children}
        </main>
      </div>

      {/* Mobile bottom tab bar — hidden on desktop */}
      <MobileBottomBar ctx={ctx} />
    </div>
  );
}
