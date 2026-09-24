// The frame every Organization tab renders in (pages/organization.md): the
// permission check, the three reads the header and the tab counts need, the
// four not-loaded states, then the header, the tabs and the tab's own body.
//
// Read requires `org.admin`, which the app maps to the organization's Owner and
// Admin roles (ARCHITECTURE.md §1.5): a member below them gets the denied
// state from the server before anything on the page is read, so the check is
// never only a hidden button. Each handler behind these reads checks the role
// again (INV-29).
//
// The members, the roles and the workspaces are read once here and handed to
// the tab, so a tab that draws one of them does not read it twice. A failure
// of any of the three replaces the body with the error or denied state; a
// tab's own further read (API keys, Data plane, Cost centers) reports its
// failure inside the tab.
import type { ReactNode } from "react";
import type {
  MemberList,
  RoleCatalog,
  WorkspaceList,
} from "@/data/contracts/org";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import { getSession } from "@/server/session";
import type { OrgCtx, OrgRole } from "@/server/viewer";
import { routes, type SafePath } from "@/shared/safe-path";
import { OrganizationHeader } from "./header";
import {
  OrganizationDenied,
  OrganizationEmpty,
  OrganizationError,
} from "./states";
import { type OrganizationTab, OrganizationTabs } from "./tabs";

/** The org roles `org.admin` names: the ones that may read this page. */
const ORG_ADMIN_ROLES: readonly OrgRole[] = ["owner", "admin"];

type FrameReads = {
  members: MemberList;
  roles: RoleCatalog;
  workspaces: WorkspaceList;
};

type Failed = Exclude<Read<unknown>, { ok: true }>;

/** The first failure among the frame's reads, in the order the page needs them. */
function firstFailure(reads: readonly Read<unknown>[]): Failed | null {
  for (const read of reads) if (!read.ok) return read;
  return null;
}

/** The instant a read failed, as the error state's trace line prints it. */
function instantOfRead(): string {
  return new Date()
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, "Z");
}

/** Back to Fleet: the first live workspace this person belongs to, else the app root. */
function fleetOf(org: string, workspaces: Read<WorkspaceList>): SafePath {
  if (!workspaces.ok) return routes.root();
  const home = workspaces.value.workspaces.find(
    (ws) => ws.role !== null && ws.archivedAt === null,
  );
  return home === undefined ? routes.root() : routes.fleet(org, home.slug);
}

/**
 * The denied state with who is signed in and where Back to Fleet goes. A plain
 * async function rather than a component, so the frame awaits it and hands back
 * finished markup.
 */
async function denied(ctx: OrgCtx, source: DataSource): Promise<ReactNode> {
  const [session, workspaces] = await Promise.all([
    getSession(),
    source.org.workspaces(ctx),
  ]);
  const name = session?.user.name ?? session?.user.email ?? ctx.orgRole;
  return (
    <OrganizationDenied
      org={ctx.orgSlug}
      orgName={ctx.orgName}
      name={name}
      role={ctx.orgRole}
      fleet={fleetOf(ctx.orgSlug, workspaces)}
    />
  );
}

export async function OrganizationFrame({
  ctx,
  source,
  current,
  retry,
  children,
}: {
  ctx: OrgCtx;
  source: DataSource;
  current: OrganizationTab;
  /** This tab's own URL, which Try again reloads. */
  retry: SafePath;
  /** The tab's body, handed the frame's reads; it may read more of its own. */
  children: (reads: FrameReads) => ReactNode | Promise<ReactNode>;
}) {
  if (!ORG_ADMIN_ROLES.includes(ctx.orgRole)) return denied(ctx, source);
  const [members, roles, workspaces] = await Promise.all([
    source.org.members(ctx),
    source.org.roles(ctx),
    source.org.workspaces(ctx),
  ]);
  const failed = firstFailure([members, roles, workspaces]);
  if (failed !== null) {
    if (failed.reason !== "error") return denied(ctx, source);
    return (
      <OrganizationError
        failure={failed}
        retry={retry}
        readAt={instantOfRead()}
      />
    );
  }
  if (!members.ok || !roles.ok || !workspaces.ok) return null;
  const live = workspaces.value.workspaces.filter(
    (ws) => ws.archivedAt === null,
  );
  if (live.length === 0) return <OrganizationEmpty org={ctx.orgSlug} />;
  return (
    <div className="flex flex-col gap-4">
      <OrganizationHeader
        ctx={ctx}
        pendingIds={members.value.invitations.map((i) => i.id)}
      />
      <OrganizationTabs
        org={ctx.orgSlug}
        current={current}
        counts={{
          people: members.value.members.length,
          roles: roles.value.roles.length,
          invitations: members.value.invitations.length,
          workspaces: workspaces.value.workspaces.length,
        }}
      />
      {
        await children({
          members: members.value,
          roles: roles.value,
          workspaces: workspaces.value,
        })
      }
    </div>
  );
}
