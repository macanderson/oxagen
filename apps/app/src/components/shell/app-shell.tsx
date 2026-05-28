import type { ReactNode } from "react";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import type { ResolvedTenant, ResolvedWorkspace } from "@/lib/resolve-tenant";

export interface AppShellProps {
  tenant: ResolvedTenant;
  workspace?: ResolvedWorkspace;
  availableTenants: { publicId: string; slug: string; name: string }[];
  availableWorkspaces?: { publicId: string; slug: string; name: string }[];
  children: ReactNode;
}

export function AppShell({ tenant, workspace, availableTenants, availableWorkspaces, children }: AppShellProps) {
  return (
    <div className="flex h-dvh w-full overflow-hidden">
      <Sidebar tenantSlug={tenant.slug} workspaceSlug={workspace?.slug} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          tenant={tenant}
          workspace={workspace}
          availableTenants={availableTenants}
          availableWorkspaces={availableWorkspaces}
        />
        <main className="flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  );
}
