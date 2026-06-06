import { eq } from "drizzle-orm";
import { db } from "@oxagen/database/client";
import { schema } from "@oxagen/database";
import { resolveOrg, resolveWorkspace } from "@/lib/resolve-org";
import { getSession } from "@/lib/session";

/**
 * Workspace Settings → Members
 *
 * Lists all members who have access to this workspace (via workspace_users).
 * Shows each member's workspace role alongside their org role for context.
 *
 * Mutating workspace role assignments (workspace-scoped grants) is a
 * separate capability (org.workspace.member.role.change, planned) — out of
 * scope for this PR. The org-level role and remove controls live at
 * /{orgSlug}/members; this page shows the read-only workspace membership
 * view with a link to the org-level management page.
 */

export default async function WorkspaceSettingsMembersPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const [org, session] = await Promise.all([resolveOrg(orgSlug), getSession()]);
  const workspace = await resolveWorkspace(org.id, workspaceSlug);

  // Workspace membership with user info. Join workspace_users → users.
  const members = await db()
    .select({
      publicId: schema.workspaceUsers.publicId,
      userId: schema.workspaceUsers.userId,
      wsRole: schema.workspaceUsers.role,
      joinedAt: schema.workspaceUsers.joinedAt,
      email: schema.users.email,
      displayName: schema.users.displayName,
    })
    .from(schema.workspaceUsers)
    .innerJoin(schema.users, eq(schema.users.id, schema.workspaceUsers.userId))
    .where(eq(schema.workspaceUsers.workspaceId, workspace.id));

  // Org roles for each member (for contextual display).
  const orgMemberIds = members.map((m) => m.userId);
  const orgRoles =
    orgMemberIds.length > 0
      ? await db()
          .select({
            userId: schema.orgUsers.userId,
            orgRole: schema.orgUsers.role,
          })
          .from(schema.orgUsers)
          .where(eq(schema.orgUsers.orgId, org.id))
      : [];

  const orgRoleByUserId = new Map(orgRoles.map((r) => [r.userId, r.orgRole]));

  const viewerUserId = session?.user?.id ?? "";

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-base font-semibold text-foreground">Workspace members</h2>
        <p className="text-sm text-muted-foreground">
          Members with access to <strong>{workspace.name}</strong>. To manage org-level
          membership and roles, visit{" "}
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
        <p className="text-sm text-muted-foreground">No members in this workspace yet.</p>
      ) : (
        <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
          {members.map((m) => {
            const orgRole = orgRoleByUserId.get(m.userId);
            const isSelf = m.userId === viewerUserId;
            return (
              <li
                key={m.publicId}
                className="flex items-center justify-between px-4 py-3"
              >
                <div className="flex flex-col">
                  <span className="font-medium text-sm">
                    {m.displayName ?? m.email}
                    {isSelf ? (
                      <span className="ml-1.5 text-xs text-muted-foreground">(you)</span>
                    ) : null}
                  </span>
                  <span className="text-xs text-muted-foreground">{m.email}</span>
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
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
