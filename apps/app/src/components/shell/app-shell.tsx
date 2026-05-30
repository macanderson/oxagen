import type { ReactNode } from "react";
import { Sidebar } from "./sidebar";
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
      <Sidebar orgSlug={org.slug} workspaceSlug={workspace?.slug} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          org={org}
          workspace={workspace}
          availableOrgs={availableOrgs}
          availableWorkspaces={availableWorkspaces}
        />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
