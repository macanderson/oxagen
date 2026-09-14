import { and, eq, inArray } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { ErrorState } from "@/app/[orgSlug]/[workspaceSlug]/_shared/components";

/**
 * Workspace Settings → General → Members (sub-tab body).
 *
 * The "Members" sub-tab body inside `settings/general/page.tsx` (see
 * general-settings-tabs.tsx). Org + workspace + session are resolved ONCE by
 * the parent page and passed down — this component only runs the members
 * query and renders the list.
 *
 * Lists all members who have access to this workspace (via workspace_users).
 * Shows each member's workspace role alongside their org role for context.
 *
 * Read-only by design: mutating workspace role assignments is a separate,
 * not-yet-built capability. The org-level role and remove controls live at
 * /{orgSlug}/members, which this panel links to.
 *
 * A read failure degrades to an inline ErrorState notice instead of throwing,
 * so one bad query cannot 500 the whole General settings page.
 */

export interface WorkspaceMembersPanelProps {
  orgId: string;
  workspaceId: string;
  workspaceName: string;
  orgSlug: string;
  viewerUserId: string;
}

interface MemberRow {
  publicId: string;
  userId: string;
  wsRole: string;
  email: string;
  displayName: string | null;
}

export async function WorkspaceMembersPanel({
  orgId,
  workspaceId,
  workspaceName,
  orgSlug,
  viewerUserId,
}: WorkspaceMembersPanelProps) {
  let members: MemberRow[];
  let orgRoleByUserId: Map<string, string>;

  try {
    // Workspace membership with user info. Join workspace_users → users.
    // Tenant-scoped read (RLS): org + workspace scope established explicitly.
    members = await runInTenantScope({ orgId, workspaceId }, () =>
      withTenantDb((tx) =>
        tx
          .select({
            publicId: schema.workspaceUsers.publicId,
            userId: schema.workspaceUsers.userId,
            wsRole: schema.workspaceUsers.role,
            email: schema.users.email,
            displayName: schema.users.displayName,
          })
          .from(schema.workspaceUsers)
          .innerJoin(
            schema.users,
            eq(schema.users.id, schema.workspaceUsers.userId),
          )
          .where(eq(schema.workspaceUsers.workspaceId, workspaceId)),
      ),
    );

    // Org roles for each member (for contextual display). Narrowed to the
    // workspace's own members — the org can hold far more rows than this
    // panel ever renders, and only these ids are looked up below.
    const orgMemberIds = members.map((m) => m.userId);
    const orgRoles =
      orgMemberIds.length > 0
        ? await runInTenantScope({ orgId, workspaceId }, () =>
            withTenantDb((tx) =>
              tx
                .select({
                  userId: schema.orgUsers.userId,
                  orgRole: schema.orgUsers.role,
                })
                .from(schema.orgUsers)
                .where(
                  and(
                    eq(schema.orgUsers.orgId, orgId),
                    inArray(schema.orgUsers.userId, orgMemberIds),
                  ),
                ),
            ),
          )
        : [];

    orgRoleByUserId = new Map(orgRoles.map((r) => [r.userId, r.orgRole]));
  } catch {
    // Degrade to an inline notice — never let a members-read failure 500 the
    // whole (otherwise-healthy) General/Members settings page.
    return (
      <ErrorState
        title="Couldn't load workspace members"
        description="Something went wrong loading the member list. Try reloading the page."
      />
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-foreground">
          Workspace members
        </h2>
        <p className="text-sm text-muted-foreground">
          Members with access to <strong>{workspaceName}</strong>. To manage
          org-level membership and roles, visit{" "}
          <a
            href={`/${orgSlug}/members`}
            className="font-medium underline underline-offset-2 hover:no-underline"
          >
            Organization Members
          </a>
          .
        </p>
      </div>

      {members.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No members in this workspace yet.
        </p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
          {members.map((m) => {
            const orgRole = orgRoleByUserId.get(m.userId);
            const isSelf = m.userId === viewerUserId;
            return (
              <li
                key={m.publicId}
                className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex flex-col">
                  <span className="font-medium text-sm">
                    {m.displayName ?? m.email}
                    {isSelf ? (
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        (you)
                      </span>
                    ) : null}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {m.email}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {orgRole ? (
                    <span className="rounded border border-border/60 px-1.5 py-0.5 text-xs font-medium">
                      org: {orgRole}
                    </span>
                  ) : null}
                  <span className="rounded border border-border/60 px-1.5 py-0.5 text-xs font-medium">
                    ws: {m.wsRole}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
