import { ThemeToggle } from "./theme-toggle";
import { TenantSwitcher } from "@/components/tenant/tenant-switcher";
import { WorkspaceSwitcher } from "@/components/workspace/workspace-switcher";
import type { ResolvedTenant, ResolvedWorkspace } from "@/lib/resolve-tenant";

export interface TopbarProps {
  tenant: ResolvedTenant;
  workspace?: ResolvedWorkspace;
  availableTenants: { publicId: string; slug: string; name: string }[];
  availableWorkspaces?: { publicId: string; slug: string; name: string }[];
}

export function Topbar({ tenant, workspace, availableTenants, availableWorkspaces }: TopbarProps) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b border-border/40 bg-background/30 px-4 backdrop-blur-xl">
      <div className="flex items-center gap-2">
        <TenantSwitcher current={tenant} tenants={availableTenants} />
        {workspace ? (
          <>
            <span className="text-muted-foreground">/</span>
            <WorkspaceSwitcher tenantSlug={tenant.slug} current={workspace} workspaces={availableWorkspaces ?? []} />
          </>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <ThemeToggle />
      </div>
    </header>
  );
}
