// The Organization pages' bodies (pages/organization.md,
// organization-roles.md, organization-api-keys.md): each renders inside the
// frame, which checks the permission, reads what the header and the tab
// counts need, and draws the not-loaded states. The route passes the tab; the
// frame hands the tab the reads it already made.
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { WorkspaceList } from "@/data/contracts/org";
import type { OrgCtx } from "@/server/viewer";
import {
  firstParam,
  type OrganizationQueryTab,
  routes,
} from "@/shared/safe-path";
import { ApiKeys } from "./api-keys";
import type { ApiKeysView } from "./api-keys-view";
import { CostCenters } from "./cost-centers";
import { DataPlaneTab } from "./data-plane";
import { OrganizationFrame } from "./frame";
import { InvitationsTab, PeopleTab } from "./people";
import { RolesTab } from "./roles";
import { WorkspacesTab } from "./workspaces";

const QUERY_TABS: readonly OrganizationQueryTab[] = [
  "people",
  "invitations",
  "workspaces",
  "dataPlane",
  "costCenters",
];

/** The `?tab=` value on `/{org}`; anything it does not name is People. */
export function parseOrganizationTab(
  value: string | string[] | undefined,
): OrganizationQueryTab {
  const wanted = firstParam(value);
  return QUERY_TABS.find((tab) => tab === wanted) ?? "people";
}

/** `/{org}`: People, Invitations, Workspaces, Data plane or Cost centers. */
export function Organization({
  ctx,
  source,
  tab,
}: {
  ctx: OrgCtx;
  source: DataSource;
  tab: OrganizationQueryTab;
}) {
  return (
    <OrganizationFrame
      ctx={ctx}
      source={source}
      current={tab}
      retry={routes.organization(ctx.orgSlug, tab)}
    >
      {({ members, roles, workspaces }) => {
        switch (tab) {
          case "invitations":
            return <InvitationsTab org={ctx.orgSlug} members={members} />;
          case "workspaces":
            return <WorkspacesTab org={ctx.orgSlug} workspaces={workspaces} />;
          case "dataPlane":
            return dataPlane(ctx, source, workspaces);
          case "costCenters":
            return <CostCenters ctx={ctx} source={source} />;
          default:
            return (
              <PeopleTab org={ctx.orgSlug} members={members} roles={roles} />
            );
        }
      }}
    </OrganizationFrame>
  );
}

/**
 * The Data plane tab's one read of its own, made inside the frame so a viewer
 * the frame refused never reaches it.
 */
async function dataPlane(
  ctx: OrgCtx,
  source: DataSource,
  workspaces: WorkspaceList,
) {
  const read = await source.org.dataPlane(ctx);
  return (
    <DataPlaneTab
      org={ctx.orgSlug}
      orgName={ctx.orgName}
      read={read}
      workspaces={workspaces}
    />
  );
}

/** `/{org}/roles`: the Roles tab, with the SSO group mappings beneath it. */
export function OrganizationRoles({
  ctx,
  source,
}: {
  ctx: OrgCtx;
  source: DataSource;
}) {
  return (
    <OrganizationFrame
      ctx={ctx}
      source={source}
      current="roles"
      retry={routes.roles(ctx.orgSlug)}
    >
      {async ({ roles }) => (
        <RolesTab
          org={ctx.orgSlug}
          catalog={roles}
          sso={await source.org.sso(ctx)}
        />
      )}
    </OrganizationFrame>
  );
}

/** `/{org}/api-keys`: the keys of the workspace in scope (ADR-073). */
export function OrganizationApiKeys({
  ctx,
  keysCtx,
  source,
  workspaces,
  view,
}: {
  /** The organization viewer, for the frame. */
  ctx: OrgCtx;
  /** A `WsCtx` for the workspace in scope, or the org viewer when there is none. */
  keysCtx: OrgCtx;
  source: DataSource;
  workspaces: Read<WorkspaceList>;
  view: ApiKeysView;
}) {
  return (
    <OrganizationFrame
      ctx={ctx}
      source={source}
      current="apiKeys"
      retry={routes.apiKeys(ctx.orgSlug)}
    >
      {() => (
        <ApiKeys
          ctx={keysCtx}
          source={source}
          workspaces={workspaces}
          view={view}
        />
      )}
    </OrganizationFrame>
  );
}
