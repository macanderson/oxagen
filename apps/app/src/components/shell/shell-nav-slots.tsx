"use client";

/**
 * Shell nav slots — the data-dependent header islands (org switcher, workspace
 * switcher, balance pill) resolved from a streamed `navDataPromise`.
 *
 * The org layout deliberately does NOT await the heavy nav data (org list join,
 * workspace list, credit balance) so that the shell frame + page `{children}`
 * paint immediately. These slots `use()` the promise inside `<Suspense>`
 * boundaries in ShellFrame, so each streams in when the data resolves without
 * ever blocking navigation. — progressive-loading-ux
 */

import { use } from "react";
import { usePathname } from "next/navigation";
import { OrgSwitcher, type OrgOption } from "@/components/org/org-switcher";
import { WorkspaceSwitcher } from "@/components/workspace/workspace-switcher";
import { BalancePill } from "./balance-pill";
import { Skeleton } from "@/components/ui/skeleton";
import { resolveSidebarCtx } from "@/lib/sidebar";
import type { ResolvedOrg, ResolvedWorkspace } from "@/lib/resolve-org";
import type { NewWorkspaceAction } from "@/components/workspace/new-workspace-form";

/** Heavy, deferrable nav data fetched off the layout's critical path. */
export interface ShellNavData {
  availableOrgs: OrgOption[];
  availableWorkspaces: { publicId: string; slug: string; name: string }[];
  balance: { cents: number; low: boolean } | null;
}

/** Org switcher button — `current` is known synchronously; the org list streams. */
export function OrgSwitcherSlot({
  org,
  navDataPromise,
}: {
  org: ResolvedOrg;
  navDataPromise: Promise<ShellNavData>;
}) {
  const { availableOrgs } = use(navDataPromise);
  return <OrgSwitcher current={org} organizations={availableOrgs} />;
}

/** Fallback sized to the org switcher button so the header doesn't shift. */
export function OrgSwitcherFallback() {
  return <Skeleton className="h-7 w-32 rounded-md" aria-hidden="true" />;
}

/**
 * Workspace switcher — only shown when a workspace is active. On workspace
 * routes the shell (mounted at the org layout) can't see the route param, so
 * the active workspace is recovered from the URL against the streamed list.
 */
export function WorkspaceSwitcherSlot({
  org,
  workspace,
  navDataPromise,
  createWorkspaceAction,
}: {
  org: ResolvedOrg;
  workspace?: ResolvedWorkspace;
  navDataPromise: Promise<ShellNavData>;
  createWorkspaceAction?: NewWorkspaceAction;
}) {
  // usePathname() MUST be called before use(navDataPromise): use() can suspend
  // (the promise is pending on a client transition), and any Hook that runs
  // AFTER a suspending use() changes the hook count between the suspended and
  // resumed renders — React throws "Rendered more hooks than during the
  // previous render." Keeping every real Hook above use() holds the count
  // stable across suspend/resume. This crash surfaced on org→workspace client
  // navigation once /{org}/workspaces gave the org shell a stable page to
  // navigate from. — workspaces-home-page
  const pathname = usePathname();
  const { availableWorkspaces } = use(navDataPromise);
  const ctx = resolveSidebarCtx(pathname, {
    orgSlug: org.slug,
    workspaceSlug: workspace?.slug,
  });
  const currentWorkspace =
    (workspace
      ? {
          publicId: workspace.publicId,
          slug: workspace.slug,
          name: workspace.name,
        }
      : availableWorkspaces.find((w) => w.slug === ctx.workspaceSlug)) ?? null;

  if (!currentWorkspace) return null;

  return (
    <>
      <span
        className="select-none text-sm text-muted-foreground/50"
        aria-hidden="true"
      >
        /
      </span>
      <WorkspaceSwitcher
        orgSlug={org.slug}
        current={currentWorkspace}
        workspaces={availableWorkspaces}
        createWorkspaceAction={createWorkspaceAction}
      />
    </>
  );
}

/** Credit balance pill — hidden until the balance resolves (null hides it). */
export function BalanceSlot({
  orgSlug,
  navDataPromise,
}: {
  orgSlug: string;
  navDataPromise: Promise<ShellNavData>;
}) {
  const { balance } = use(navDataPromise);
  if (!balance) return null;
  return (
    <BalancePill
      orgSlug={orgSlug}
      balanceCents={balance.cents}
      low={balance.low}
    />
  );
}
