/**
 * AppShell — the top-level layout chrome.
 *
 * A floating left-nav shell (stock coss ui, no glass):
 *   Desktop: a floating, collapsible Sidebar card + an inset content panel
 *            whose header holds the toggle, Ask bar, and (right) the org /
 *            workspace pickers + notifications.
 *   Mobile:  the content panel goes full-bleed; navigation is the thumb-reachable
 *            fixed MobileBottomBar (tabs + a "More" sheet for overflow + account).
 *
 * The shell is a server component. Collapse state + the interactive header live
 * in the client ShellFrame, wrapped here in SidebarProvider. PageContextProvider,
 * AskDrawer, and CommandMenu are mounted in the route layout (not here).
 */

import type { ReactNode } from "react";
import { SidebarProvider } from "./sidebar-context";
import { ShellFrame } from "./shell-frame";
import { MobileBottomBar } from "./mobile-bottom-bar";
import type { OrgOption } from "@/components/org/org-switcher";
import type { ResolvedOrg, ResolvedWorkspace } from "@/lib/resolve-org";
import type { SessionUser } from "./user-switcher";
import { createWorkspaceAction } from "@/app/[orgSlug]/new-workspace/actions";
import type { NewWorkspaceAction } from "@/components/workspace/new-workspace-form";

export interface AppShellProps {
  org: ResolvedOrg;
  workspace?: ResolvedWorkspace;
  availableOrgs: OrgOption[];
  availableWorkspaces?: { publicId: string; slug: string; name: string }[];
  /** May be undefined during a transient post-signup render; guarded in UserSwitcher. */
  user: SessionUser | undefined;
  /** Org credit balance for the always-visible header pill. Null hides it. */
  balance?: { cents: number; low: boolean } | null;
  children: ReactNode;
}

export function AppShell({
  org,
  workspace,
  availableOrgs,
  availableWorkspaces,
  user,
  balance,
  children,
}: AppShellProps) {
  const ctx = { orgSlug: org.slug, workspaceSlug: workspace?.slug };

  // Bind the org slug so the client switcher/dialog only deal with FormData.
  // The type cast is safe: .bind drops the first positional arg, yielding
  // exactly the NewWorkspaceAction signature.
  const boundCreateWorkspace = createWorkspaceAction.bind(
    null,
    org.slug,
  ) as NewWorkspaceAction;

  return (
    <SidebarProvider>
      <ShellFrame
        org={org}
        workspace={workspace}
        availableOrgs={availableOrgs}
        availableWorkspaces={availableWorkspaces}
        user={user}
        balance={balance}
        createWorkspaceAction={boundCreateWorkspace}
      >
        {children}
      </ShellFrame>

      {/* Mobile bottom tab bar — the sole mobile nav; hidden on desktop. */}
      <MobileBottomBar ctx={ctx} user={user} />
    </SidebarProvider>
  );
}
