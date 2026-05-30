import { ThemeToggle } from "./theme-toggle";
import { OrgSwitcher } from "@/components/org/org-switcher";
import { WorkspaceSwitcher } from "@/components/workspace/workspace-switcher";
import type { ResolvedOrg, ResolvedWorkspace } from "@/lib/resolve-org";

export interface TopbarProps {
  tenant: ResolvedOrg;
  workspace?: ResolvedWorkspace;
  availableOrgs: { publicId: string; slug: string; name: string }[];
  availableWorkspaces?: { publicId: string; slug: string; name: string }[];
}

export function Topbar({ tenant, workspace, availableOrgs, availableWorkspaces }: TopbarProps) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b border-border/40 bg-background/30 px-4 backdrop-blur-xl">
      <div className="flex items-center gap-2">
        <OrgSwitcher current={tenant} organizations={availableOrgs} />
        {workspace ? (
          <>
            <span className="text-muted-foreground">/</span>
            <WorkspaceSwitcher orgSlug={tenant.slug} current={workspace} workspaces={availableWorkspaces ?? []} />
          </>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <ThemeToggle />
      </div>
    </header>
  );
}
