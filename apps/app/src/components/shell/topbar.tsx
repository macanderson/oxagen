import { ThemeToggle } from "./theme-toggle";
import { MobileNav } from "./mobile-nav";
import { OrgSwitcher } from "@/components/org/org-switcher";
import { WorkspaceSwitcher } from "@/components/workspace/workspace-switcher";
import type { ResolvedOrg, ResolvedWorkspace } from "@/lib/resolve-org";

export interface TopbarProps {
  org: ResolvedOrg;
  workspace?: ResolvedWorkspace;
  availableOrgs: { publicId: string; slug: string; name: string }[];
  availableWorkspaces?: { publicId: string; slug: string; name: string }[];
}

export function Topbar({ org, workspace, availableOrgs, availableWorkspaces }: TopbarProps) {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center justify-between gap-4 border-b border-border/40 bg-background/30 px-4 backdrop-blur-xl">
      <div className="flex items-center gap-2">
        {/* Drawer trigger — only visible below md where the sidebar is hidden */}
        <MobileNav orgSlug={org.slug} workspaceSlug={workspace?.slug} />
        <OrgSwitcher current={org} organizations={availableOrgs} />
        {workspace ? (
          <>
            <span className="text-muted-foreground">/</span>
            <WorkspaceSwitcher orgSlug={org.slug} current={workspace} workspaces={availableWorkspaces ?? []} />
          </>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <ThemeToggle />
      </div>
    </header>
  );
}
