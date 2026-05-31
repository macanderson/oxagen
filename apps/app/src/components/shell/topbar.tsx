/**
 * Topbar — the application shell header.
 *
 * Layout (left → right):
 *   [Brand mark] [OrgSwitcher chip] / [WorkspaceSwitcher chip]  …flex spacer…  [AskBar]  [NotificationsBell]  [AvatarMenu]
 *
 * WorkspaceSwitcher chip is hidden in org/account mode (workspace prop absent).
 *
 * AskBar is a client component that requires a ScopeContext for intent routing.
 * The topbar itself is a server component; it renders the client AskBar with
 * the resolved context passed as a prop.
 *
 * Brand mark: the Oxagen broken-ring icon (gradient SVG) linking to the last
 * workspace or the org root when no workspace is present.
 */

import Link from "next/link";
import { MobileNav } from "./mobile-nav";
import { AskBar } from "@/components/shell/ask/ask-bar";
import { NotificationsBell } from "./notifications-bell";
import { AvatarMenu } from "./avatar-menu";
import { OrgSwitcher } from "@/components/org/org-switcher";
import { WorkspaceSwitcher } from "@/components/workspace/workspace-switcher";
import type { ResolvedOrg, ResolvedWorkspace } from "@/lib/resolve-org";
import type { SessionUser } from "./avatar-menu";
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
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border/40 bg-background/30 px-4 backdrop-blur-xl">
      {/* Left: brand mark + drawer trigger + breadcrumb chips */}
      <div className="flex min-w-0 items-center gap-2">
        {/* Mobile hamburger — only below md */}
        <MobileNav
          ctx={{ orgSlug: org.slug, workspaceSlug: workspace?.slug }}
          org={org}
          workspace={workspace}
          availableOrgs={availableOrgs}
          availableWorkspaces={availableWorkspaces}
          user={user}
        />

        {/* Brand mark — gradient broken-ring icon */}
        <Link
          href={homeHref}
          aria-label="Oxagen home"
          className="hidden shrink-0 items-center justify-center md:flex"
        >
          {/* Oxagen gradient ring icon (inline SVG to avoid external asset dep) */}
          <svg
            width="24"
            height="24"
            viewBox="0 0 32 32"
            fill="none"
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="oxagen-ring-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#7182ff" />
                <stop offset="100%" stopColor="#3cff52" />
              </linearGradient>
            </defs>
            {/* Broken ring — open at bottom-right ~45 degrees */}
            <path
              d="M16 3C8.82 3 3 8.82 3 16s5.82 13 13 13c5.22 0 9.73-3.09 11.83-7.56"
              stroke="url(#oxagen-ring-gradient)"
              strokeWidth="3"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
        </Link>

        {/* OrgSwitcher breadcrumb chip */}
        <OrgSwitcher current={org} organizations={availableOrgs} />

        {/* Workspace chip — hidden in org/account mode */}
        {workspace ? (
          <>
            <span className="text-muted-foreground/60 select-none" aria-hidden="true">/</span>
            <WorkspaceSwitcher
              orgSlug={org.slug}
              current={workspace}
              workspaces={availableWorkspaces ?? []}
            />
          </>
        ) : null}
      </div>

      {/* Right: AskBar + bells + avatar */}
      <div className="flex shrink-0 items-center gap-2">
        <AskBar ctx={ctx} />
        <NotificationsBell />
        <AvatarMenu user={user} />
      </div>
    </header>
  );
}
