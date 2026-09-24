// The Organization pages' bodies (pages/organization.md,
// organization-roles.md, organization-api-keys.md), Model funding and routes
// among them: each renders inside the
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
import { ModelFundingTab } from "./model-funding";
import { OrganizationFrame } from "./frame";
import { InvitationsTab, PeopleTab } from "./people";
import { RolesTab } from "./roles";
import { readWorkspaceFacts } from "./workspace-reads";
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
      {({ members, roles, workspaces, twoFactor, enterable }) => {
        switch (tab) {
          case "invitations":
            return (
              <InvitationsTab
                org={ctx.orgSlug}
                members={members}
                twoFactorRequired={twoFactor.required}
              />
            );
          case "workspaces":
            return workspacesTab(ctx, workspaces, enterable);
          case "dataPlane":
            return dataPlane(ctx, source, workspaces);
          case "costCenters":
            return <CostCenters ctx={ctx} source={source} />;
          default:
            return (
              <PeopleTab
                org={ctx.orgSlug}
                members={members}
                roles={roles}
                twoFactorRequired={twoFactor.required}
              />
            );
        }
      }}
    </OrganizationFrame>
  );
}

/**
 * The Workspaces tab, with what each workspace the viewer may enter binds and
 * registers: one `list_repositories` and one `list_agents` inside each, made
 * together. A workspace the viewer is not a member of is not read, and its
 * row says "not recorded" for those cells.
 */
async function workspacesTab(
  ctx: OrgCtx,
  workspaces: WorkspaceList,
  enterable: readonly string[],
) {
  const facts = new Map(
    await Promise.all(
      enterable.map(
        async (slug) =>
          [slug, await readWorkspaceFacts(ctx.orgSlug, slug)] as const,
      ),
    ),
  );
  return (
    <WorkspacesTab
      org={ctx.orgSlug}
      workspaces={workspaces}
      facts={facts}
      enterable={enterable}
    />
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

/**
 * `/{org}/model-funding`: Model funding and routes. Its one read of its own is
 * made inside the frame, so a viewer the frame refused never reaches it.
 */
export function OrganizationModelFunding({
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
      current="modelFunding"
      retry={routes.modelFunding(ctx.orgSlug)}
    >
      {async () => (
        <ModelFundingTab
          org={ctx.orgSlug}
          orgName={ctx.orgName}
          read={await source.org.modelCredential(ctx)}
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
