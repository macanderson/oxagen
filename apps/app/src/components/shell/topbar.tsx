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
import { BrandMark, OxagenWordmark } from "@/components/ui/brand";
import { MobileNav } from "./mobile-nav";
import { AskBar } from "@/components/shell/ask/ask-bar";
import { NotificationsBell } from "./notifications-bell";
import { OrgSwitcher } from "@/components/org/org-switcher";
import { WorkspaceSwitcher } from "@/components/workspace/workspace-switcher";
import { UserSwitcher, type SessionUser } from "./user-switcher";
import type { ResolvedOrg, ResolvedWorkspace } from "@/lib/resolve-org";
import type { ScopeContext } from "@/lib/scope";

/** Muted "/" separator between brand and the org / workspace switchers. */
function Slash() {
  return (
    <span className="select-none text-sm text-muted-foreground/50" aria-hidden="true">
      /
    </span>
  );
}

export interface TopbarProps {
  org: ResolvedOrg;
  workspace?: ResolvedWorkspace;
  availableOrgs: { publicId: string; slug: string; name: string }[];
  availableWorkspaces?: { publicId: string; slug: string; name: string }[];
  /** May be undefined during a transient post-signup render; guarded in UserSwitcher. */
  user: SessionUser | undefined;
}

export function Topbar({
  org,
  workspace,
  availableOrgs,
  availableWorkspaces,
  user,
}: TopbarProps) {
  const homeHref = workspace
    ? `/${org.slug}/${workspace.slug}/ask`
    : `/${org.slug}`;

  const ctx: ScopeContext = {
    orgSlug: org.slug,
    workspaceSlug: workspace?.slug,
  };

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-background px-4">
      {/* Left: hamburger (mobile) + brand + org / workspace breadcrumb */}
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
          className="flex shrink-0 items-center gap-2"
        >
          <BrandMark />
          <OxagenWordmark className="hidden h-3.5 w-auto text-foreground md:block" />
        </Link>

        {/* Breadcrumb switchers: oxagen / org ▾ / workspace ▾ */}
        <div className="hidden min-w-0 items-center gap-2 sm:flex">
          <Slash />
          <OrgSwitcher current={org} organizations={availableOrgs} />
          {workspace ? (
            <>
              <Slash />
              <WorkspaceSwitcher
                orgSlug={org.slug}
                current={workspace}
                workspaces={availableWorkspaces ?? []}
              />
            </>
          ) : null}
        </div>
      </div>

      {/* Center: ask bar — the prominent workspace search/command centerpiece */}
      <div className="hidden min-w-0 flex-1 justify-center px-2 sm:flex">
        <div className="w-full max-w-xl">
          <AskBar ctx={ctx} />
        </div>
      </div>

      {/* Right: notifications + account avatar (theme lives in the avatar menu) */}
      <div className="flex shrink-0 items-center gap-1.5">
        <NotificationsBell />
        <UserSwitcher user={user} variant="avatar" />
      </div>
    </header>
  );
}
