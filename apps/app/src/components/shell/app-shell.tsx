import type { ReactNode } from "react";
import { Sidebar, MobileBottomBar } from "./sidebar";
import { Topbar } from "./topbar";
import type { ResolvedOrg, ResolvedWorkspace } from "@/lib/resolve-org";

export interface AppShellProps {
  org: ResolvedOrg;
  workspace?: ResolvedWorkspace;
  availableOrgs: { publicId: string; slug: string; name: string }[];
  availableWorkspaces?: { publicId: string; slug: string; name: string }[];
  children: ReactNode;
}

export function AppShell({ org, workspace, availableOrgs, availableWorkspaces, children }: AppShellProps) {
  return (
    <div className="flex h-dvh w-full overflow-hidden">
      {/* Desktop sidebar — hidden on mobile */}
      <Sidebar orgSlug={org.slug} workspaceSlug={workspace?.slug} />

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          org={org}
          workspace={workspace}
          availableOrgs={availableOrgs}
          availableWorkspaces={availableWorkspaces}
        />
        {/*
          On mobile the bottom bar is fixed/overlapping, so we add a bottom
          padding equal to the bar height (~56 px) only at < md so content
          doesn't hide behind it.
        */}
        <main className="flex-1 overflow-y-auto p-4 pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:p-6 md:pb-6">
          {children}
        </main>
      </div>

      {/* Mobile bottom tab bar — hidden on desktop */}
      <MobileBottomBar orgSlug={org.slug} workspaceSlug={workspace?.slug} />
    </div>
  );
}
