/**
 * AppShell — the top-level layout chrome.
 *
 * A floating left-nav shell (stock coss ui, no glass):
 *   Desktop: a floating, collapsible Sidebar card + an inset content panel
 *            whose header holds the toggle, Ask bar, and (right) the org /
 *            workspace pickers + notifications.
 *   Mobile:  the content panel goes full-bleed; nav is a drawer (MobileNav,
 *            opened from the header) plus a fixed MobileBottomBar.
 *
 * The shell is a server component. Collapse state + the interactive header live
 * in the client ShellFrame, wrapped here in SidebarProvider. PageContextProvider,
 * AskDrawer, and CommandMenu are mounted in the route layout (not here).
 */

import type { ReactNode } from "react";
import { SidebarProvider } from "./sidebar-context";
import { ShellFrame } from "./shell-frame";
import { MobileBottomBar } from "./sidebar";
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
        createWorkspaceAction={boundCreateWorkspace}
      >
        {children}
      </ShellFrame>

      {/* Mobile bottom tab bar — hidden on desktop */}
      <MobileBottomBar ctx={ctx} />
    </SidebarProvider>
  );
}
