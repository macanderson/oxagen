/**
 * page.tsx — Workspace → Settings → GitHub.
 *
 * Home of the Oxagen GitHub App install (1 workspace = 1 app install). Connecting
 * here establishes the workspace's GitHub OAuth token + App installation; the
 * Sources tab then only SELECTS repos to ingest from what the install grants.
 *
 * The page resolves the viewer's workspace role server-side so the client panel
 * can gate the connect/disconnect affordances to managers (owner/admin) — the app
 * does not bootstrap IAM, so the gate lives at the call site (see CLAUDE.md).
 */
import { eq, and } from "drizzle-orm";
import { withTenantDb, schema } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";
import { GithubConnectionSettings } from "./github-connection-settings";

export default async function SettingsGithubPage({
  params,
}: {
  params: Promise<{ orgSlug: string; workspaceSlug: string }>;
}) {
  const { orgSlug, workspaceSlug } = await params;
  const session = await getSessionOrRedirect();
  const org = await resolveOrg(orgSlug);
  const ws = await resolveWorkspace(org.id, workspaceSlug);
  await assertOrgMember(org.id, session.user.id);

  const [wsRoleRow] = await runInTenantScope(
    { orgId: org.id, workspaceId: ws.id },
    () =>
      withTenantDb((tx) =>
        tx
          .select({ role: schema.workspaceUsers.role })
          .from(schema.workspaceUsers)
          .where(
            and(
              eq(schema.workspaceUsers.workspaceId, ws.id),
              eq(schema.workspaceUsers.userId, session.user.id),
            ),
          )
          .limit(1),
      ),
  );

  const wsRole = wsRoleRow?.role ?? "viewer";
  const canManage = ["owner", "admin"].includes(wsRole.toLowerCase());

  return (
    <GithubConnectionSettings
      orgSlug={orgSlug}
      workspaceSlug={workspaceSlug}
      canManage={canManage}
    />
  );
}
