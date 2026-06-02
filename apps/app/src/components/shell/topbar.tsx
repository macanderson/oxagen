/**
 * Topbar — the application shell header (stock shadcn surface).
 *
 * Layout (left → right):
 *   [hamburger (mobile)] [Oxagen wordmark] [OrgSwitcher]
 *     …flex AskBar…
 *   [NotificationsBell] [WorkspaceSwitcher] [ThemeToggle]
 *
 * WorkspaceSwitcher is hidden in org/account mode (workspace prop absent).
 *
 * The topbar is a server component; it renders the client islands (AskBar,
 * NotificationsBell, WorkspaceSwitcher, ThemeToggle, MobileNav) with the
 * resolved scope context passed as props.
 */

import Link from "next/link";
import { MobileNav } from "./mobile-nav";
import { AskBar } from "@/components/shell/ask/ask-bar";
import { NotificationsBell } from "./notifications-bell";
import { ThemeToggle } from "./theme-toggle";
import { OrgSwitcher } from "@/components/org/org-switcher";
import { WorkspaceSwitcher } from "@/components/workspace/workspace-switcher";
import type { ResolvedOrg, ResolvedWorkspace } from "@/lib/resolve-org";
import type { SessionUser } from "./user-switcher";
import type { ScopeContext } from "@/lib/scope";

export interface TopbarProps {
  org: ResolvedOrg;
  workspace?: ResolvedWorkspace;
  availableOrgs: { publicId: string; slug: string; name: string }[];
  availableWorkspaces?: { publicId: string; slug: string; name: string }[];
  user: SessionUser;
}

export function Topbar({
  org,
  workspace,
  availableOrgs,
  availableWorkspaces,
  user,
}: TopbarProps) {
  const homeHref = workspace
    ? `/${org.slug}/${workspace.slug}/chat`
    : `/${org.slug}`;

  const ctx: ScopeContext = {
    orgSlug: org.slug,
    workspaceSlug: workspace?.slug,
  };

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between gap-3 border-b bg-background px-4">
      {/* Left: hamburger (mobile) + wordmark + org switcher */}
      <div className="flex min-w-0 items-center gap-2">
        <MobileNav
          ctx={ctx}
          org={org}
          workspace={workspace}
          availableOrgs={availableOrgs}
          availableWorkspaces={availableWorkspaces}
          user={user}
        />

        <Link
          href={homeHref}
          aria-label="Oxagen home"
          className="hidden shrink-0 items-center text-sm font-semibold tracking-tight md:flex"
        >
          Oxagen
        </Link>

        <OrgSwitcher current={org} organizations={availableOrgs} />
      </div>

      {/* Center: ask bar */}
      <div className="hidden min-w-0 flex-1 justify-center px-2 sm:flex">
        <AskBar ctx={ctx} />
      </div>

      {/* Right: notifications + workspace picker + theme switcher */}
      <div className="flex shrink-0 items-center gap-2">
        <NotificationsBell />
        {workspace ? (
          <WorkspaceSwitcher
            orgSlug={org.slug}
            current={workspace}
            workspaces={availableWorkspaces ?? []}
          />
        ) : null}
        <ThemeToggle />
      </div>
    </header>
  );
}
